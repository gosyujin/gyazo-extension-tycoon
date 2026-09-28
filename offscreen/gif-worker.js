// GIFエンコード(quantize/applyPalette/writeFrame)専用の Worker。
//
// なぜ Worker に分離したか: これらの処理はいずれもピクセル数に比例して重く、
// 特に quantize()(パレット再計算)はフレームによっては数十〜100ms超かかることがある。
// 以前はこれをフレームサンプリングと同じメインスレッド上で同期的に行っていたため、
// 重い処理が走っている間はサンプリング用の setInterval 自体が止まり、数フレームおきに
// カクつく(ガクガクする)原因になっていた。エンコードをこの Worker に完全に移し、
// メインスレッド(offscreen.js)側は毎フレーム drawImage/getImageData でピクセルを
// 取り込んで postMessage で投げるだけにすることで、エンコードがどれだけ重くても
// フレームサンプリングの間隔そのものは乱れなくなる(ただしエンコードが録画時間内に
// 追いつかない場合は完了までの時間が伸びる/バックログが溜まる。詳細は offscreen.js の
// MAX_PENDING_FRAMES 参照)。

// 「動画を軽量化する」チェックボックスがオンの場合、finish 時点でGIFがこの
// バイト数を超えていたら、フレーム数(なめらかさ)は変えずに解像度→色数の順で
// 下げながら再エンコードし、目安として概ねこのサイズに収まるよう調整する。
const LIGHTWEIGHT_TARGET_BYTES = 5 * 1024 * 1024;
// 縮小しすぎると何が写っているかわからなくなるため、長辺のこのpx数までしか縮めない。
const LIGHTWEIGHT_MIN_DIMENSION = 240;
// まず解像度をこの倍率まで段階的に下げてみて、それでも収まらない場合だけ
// 色数を下げる(色数を減らすと視覚的な劣化(バンディング)が目立ちやすいため、
// 解像度側の削減を優先する)。
const LIGHTWEIGHT_SCALE_STEPS = [0.75, 0.5, 0.35];
const LIGHTWEIGHT_COLOR_STEPS = [128, 64, 32];

// ストリーミング出力するGIFへ書き込むフレーム差分エンコード用の設定。
// GIFのパレットは256色までだが、差分の「変化なし」を表す透過インデックス用に
// 1つ空けておく必要があるため、quantize()は255色までに抑える。
const MAX_PALETTE_COLORS = 255;
const TRANSPARENT_INDEX = 255;
// 前フレームとの差分(RGB各チャンネルの絶対差の合計)がこの値以下なら「変化なし」
// とみなして透過にする。tabCaptureの映像はコーデックを経由しないため基本的に
// ピクセル完全一致するはずだが、GPU合成の端数処理などによる微小な揺れを吸収する
// ための遊び(暫定値)。大きくしすぎると実際の変化を取りこぼして残像的に見える
// リスクがあるため、あくまで「人の目にわからない程度」の小さい値にとどめる。
const FRAME_DIFF_THRESHOLD = 24;

let GIFEncoder;
let quantize;
let applyPalette;

let gif = null;
let palette = null;
let frameCount = 0;
let paletteRefreshInterval = 5;
// 直前フレームの生RGBA(差分判定用)。postMessageで受け取ったバッファは
// このWorkerが所有権を持ち他から参照されないため、コピーせず参照を保持するだけでよい。
let prevRawData = null;
// 「軽量化」がオンのときだけ、再エンコード用に各フレームの量子化済みデータ
// (index + そのフレームが使ったpalette + delay)を保持する。RGBAそのものより
// 1/4のメモリで済む(量子化はどのみち通常エンコードの過程で行っているため、
// 保持自体に追加コストはない)。再エンコード時は palette[index] で近似RGBAに
// 復元してから解像度変更・再量子化する(下記 lightenGif 参照)。
let retainFrames = false;
let retained = [];
let frameWidth = 0;
let frameHeight = 0;

async function ensureGifenc() {
  if (GIFEncoder) return;
  ({ GIFEncoder, quantize, applyPalette } = await import("../vendor/gifenc/gifenc.esm.js"));
}

self.onmessage = async (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      await ensureGifenc();
      gif = GIFEncoder();
      palette = null;
      frameCount = 0;
      paletteRefreshInterval = msg.paletteRefreshInterval || 5;
      retainFrames = !!msg.retainFrames;
      retained = [];
      prevRawData = null;
      self.postMessage({ type: "initDone" });
      break;
    }
    case "frame": {
      const { buffer, width, height, delay } = msg;
      const data = new Uint8ClampedArray(buffer);
      // パレットは毎フレームではなく数フレームに1回だけ再計算する(このWorker内で
      // 完結するため、メインスレッドのフレームサンプリングには一切影響しない)。
      if (!palette || frameCount % paletteRefreshInterval === 0) {
        palette = quantize(data, MAX_PALETTE_COLORS);
      }
      // retainFrames(「軽量化」用の保持)は常にこの「真の」量子化結果を使う。
      // 下の差分エンコードは、あくまでストリーミング出力するGIFへの書き込み方法を
      // 変えるだけで、retained側(軽量化の再エンコード用データ)には影響しない。
      const index = applyPalette(data, palette);
      if (retainFrames) {
        retained.push({ index, palette, delay });
        frameWidth = width;
        frameHeight = height;
      }

      // 前フレームとほぼ変化していないピクセルは透過色にして書き込む。
      // dispose:1("そのまま残す")と組み合わせると、変化していない領域はデコード時に
      // 前フレームの絵がそのまま透けて見える(=実質的にそのピクセルは再描画されない)。
      // GIFのLZW圧縮は同じ値が連続するほど効くため、静止部分が多い画面録画では
      // これだけでファイルサイズが大きく下がる。解像度・フレーム数・実際に変化した
      // ピクセルの色はどれも一切劣化させない(詳細はREADME参照)。
      let writeIndex = index;
      const writeOptions = { palette, delay };
      if (prevRawData) {
        writeIndex = new Uint8Array(index.length);
        for (let i = 0, o = 0; i < index.length; i++, o += 4) {
          const diff =
            Math.abs(data[o] - prevRawData[o]) +
            Math.abs(data[o + 1] - prevRawData[o + 1]) +
            Math.abs(data[o + 2] - prevRawData[o + 2]);
          writeIndex[i] = diff <= FRAME_DIFF_THRESHOLD ? TRANSPARENT_INDEX : index[i];
        }
        writeOptions.transparent = true;
        writeOptions.transparentIndex = TRANSPARENT_INDEX;
        writeOptions.dispose = 1;
      }
      gif.writeFrame(writeIndex, width, height, writeOptions);
      // 次フレームの差分判定用に、量子化前の生RGBAを保持しておく(量子化後の色を
      // 基準にすると、パレット再計算のタイミングによって差分が実際の見た目の変化と
      // ズレるため)。
      prevRawData = data;

      frameCount++;
      self.postMessage({ type: "frameDone", frameCount });
      break;
    }
    case "finish": {
      // ここまでに届いた "frame" メッセージは Worker のメッセージキュー内で
      // 順番に(同期的に)処理済みのはずなので、finish 時点で未エンコードの
      // フレームが残っていることはない。
      gif.finish();
      let bytes = gif.bytes();
      let width = frameWidth;
      let height = frameHeight;
      let lightened = false;
      if (retainFrames && retained.length > 0 && bytes.length > LIGHTWEIGHT_TARGET_BYTES) {
        console.log("[gif-worker] gif exceeds lightweight target, re-encoding", {
          originalBytes: bytes.length,
          target: LIGHTWEIGHT_TARGET_BYTES,
        });
        const result = await lightenGif(retained, frameWidth, frameHeight);
        if (result && result.bytes.length < bytes.length) {
          bytes = result.bytes;
          width = result.width;
          height = result.height;
          lightened = true;
        }
      }
      self.postMessage({ type: "done", bytes, frameCount, lightened, width, height }, [bytes.buffer]);
      gif = null;
      palette = null;
      frameCount = 0;
      retained = [];
      frameWidth = 0;
      frameHeight = 0;
      prevRawData = null;
      break;
    }
    default:
      console.warn("[gif-worker] unhandled message type", msg.type);
      break;
  }
};

// index(量子化済み1バイト/pixel) + その時点のpaletteから近似RGBAを復元する。
// 各pixelは元々そのpaletteのいずれかの色そのものだったので、劣化なく復元できる。
function reconstructRGBA(index, framePalette, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < index.length; i++) {
    const color = framePalette[index[i]];
    const o = i * 4;
    rgba[o] = color[0];
    rgba[o + 1] = color[1];
    rgba[o + 2] = color[2];
    rgba[o + 3] = color.length > 3 ? color[3] : 255;
  }
  return rgba;
}

// OffscreenCanvas(Workerでも使える)でリサイズする。同サイズならそのまま返す。
async function resizeRGBA(rgba, srcWidth, srcHeight, dstWidth, dstHeight) {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return rgba;
  const bitmap = await createImageBitmap(new ImageData(rgba, srcWidth, srcHeight));
  const canvas = new OffscreenCanvas(dstWidth, dstHeight);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, dstWidth, dstHeight);
  bitmap.close();
  return ctx.getImageData(0, 0, dstWidth, dstHeight).data;
}

// 保持しておいた各フレームを指定の解像度・色数で再エンコードする。フレーム数・
// delay はそのまま使うため、なめらかさ(コマ数)は変わらない。
async function encodeFramesAtSize(frames, srcWidth, srcHeight, dstWidth, dstHeight, maxColors) {
  const encoder = GIFEncoder();
  for (const frame of frames) {
    const rgba = reconstructRGBA(frame.index, frame.palette, srcWidth, srcHeight);
    const resized = await resizeRGBA(rgba, srcWidth, srcHeight, dstWidth, dstHeight);
    const framePalette = quantize(resized, maxColors);
    const idx = applyPalette(resized, framePalette);
    encoder.writeFrame(idx, dstWidth, dstHeight, { palette: framePalette, delay: frame.delay });
  }
  encoder.finish();
  return encoder.bytes();
}

// フレーム数を変えずに「解像度を段階的に下げる」→(まだ大きければ)「色数を段階的に
// 下げる」の順で LIGHTWEIGHT_TARGET_BYTES 程度になるまで再エンコードを試す。
// 何度も全フレームを再量子化するため軽くはないが、録画終了後1回だけの処理であり、
// 「容量を減らすためなら多少時間がかかってもよい」という機能の性質上許容している。
async function lightenGif(frames, width, height) {
  const longSide = Math.max(width, height);
  const attempts = [];
  for (const scale of LIGHTWEIGHT_SCALE_STEPS) attempts.push({ scale, maxColors: 256 });
  for (const maxColors of LIGHTWEIGHT_COLOR_STEPS) {
    attempts.push({ scale: LIGHTWEIGHT_SCALE_STEPS[LIGHTWEIGHT_SCALE_STEPS.length - 1], maxColors });
  }

  let best = null;
  let lastKey = null;
  for (const { scale, maxColors } of attempts) {
    const clampedScale = longSide * scale < LIGHTWEIGHT_MIN_DIMENSION ? LIGHTWEIGHT_MIN_DIMENSION / longSide : scale;
    const w = Math.max(1, Math.round(width * clampedScale));
    const h = Math.max(1, Math.round(height * clampedScale));
    const key = `${w}x${h}x${maxColors}`;
    if (key === lastKey) continue; // 縮小下限に達して同じ組み合わせを繰り返すだけなら省略
    lastKey = key;

    const bytes = await encodeFramesAtSize(frames, width, height, w, h, maxColors);
    console.log("[gif-worker] lightweight attempt", { w, h, maxColors, bytes: bytes.length });
    if (!best || bytes.length < best.bytes.length) best = { bytes, width: w, height: h };
    if (bytes.length <= LIGHTWEIGHT_TARGET_BYTES) break;
  }
  return best;
}
