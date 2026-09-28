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

let GIFEncoder;
let quantize;
let applyPalette;

let gif = null;
let palette = null;
let frameCount = 0;
let paletteRefreshInterval = 5;
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
      self.postMessage({ type: "initDone" });
      break;
    }
    case "frame": {
      const { buffer, width, height, delay } = msg;
      const data = new Uint8ClampedArray(buffer);
      // パレットは毎フレームではなく数フレームに1回だけ再計算する(このWorker内で
      // 完結するため、メインスレッドのフレームサンプリングには一切影響しない)。
      if (!palette || frameCount % paletteRefreshInterval === 0) {
        palette = quantize(data, 256);
      }
      const index = applyPalette(data, palette);
      gif.writeFrame(index, width, height, { palette, delay });
      if (retainFrames) {
        retained.push({ index, palette, delay });
        frameWidth = width;
        frameHeight = height;
      }
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
