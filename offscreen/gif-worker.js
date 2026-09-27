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

let GIFEncoder;
let quantize;
let applyPalette;

let gif = null;
let palette = null;
let frameCount = 0;
let paletteRefreshInterval = 5;

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
      frameCount++;
      self.postMessage({ type: "frameDone", frameCount });
      break;
    }
    case "finish": {
      // ここまでに届いた "frame" メッセージは Worker のメッセージキュー内で
      // 順番に(同期的に)処理済みのはずなので、finish 時点で未エンコードの
      // フレームが残っていることはない。
      gif.finish();
      const bytes = gif.bytes();
      self.postMessage({ type: "done", bytes, frameCount }, [bytes.buffer]);
      gif = null;
      palette = null;
      frameCount = 0;
      break;
    }
    default:
      console.warn("[gif-worker] unhandled message type", msg.type);
      break;
  }
};
