// Offscreen document: DOM/Canvas/MediaStream が必要な重い処理を一手に引き受ける。
// - PNG: キャプチャ済み data URL のトリミング・タイル結合
// - GIF: tabCapture の MediaStream からライブでフレームをサンプリングしてエンコード
// - 最終ファイルの chrome.downloads.download 呼び出し
import { GIFEncoder, quantize, applyPalette } from "../vendor/gifenc/gifenc.esm.js";

// GIFフレームのサンプリング間隔(ms)。captureVisibleTabの連続呼び出し(実質2fps程度が上限)
// より滑らかにするため、tabCaptureのライブストリームから直接サンプリングする。
// 値は暫定。画質/ファイルサイズ/CPU負荷を見ながら調整する。
const GIF_FRAME_INTERVAL_MS = 150;
// 録画の暴走防止用の暫定上限(フレーム数)。GIF_FRAME_INTERVAL_MS=150なら約45秒。
const GIF_MAX_FRAMES = 300;
const GIF_PALETTE_SIZE = 256;

let recording = null; // { stream, video, canvas, ctx, gif, intervalId, frameCount, width, height }

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return chrome.downloads
    .download({ url, filename, saveAs: false })
    .finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
}

async function loadBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

// --- PNG: 矩形/ビューポート内要素のトリミング ---
async function processCrop({ dataUrl, rect, dpr, filename }) {
  const bitmap = await loadBitmap(dataUrl);
  const sx = Math.max(0, Math.round(rect.left * dpr));
  const sy = Math.max(0, Math.round(rect.top * dpr));
  const sw = Math.min(Math.round(rect.width * dpr), bitmap.width - sx);
  const sh = Math.min(Math.round(rect.height * dpr), bitmap.height - sy);

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  await downloadBlob(blob, filename);
  return { ok: true };
}

// --- PNG: フルページ/大きい要素のタイル結合 ---
async function processTiles({ tiles, region, dpr, filename }) {
  const { pageLeft, pageTop, width, height } = region;
  const canvasWidth = Math.round(width * dpr);
  const canvasHeight = Math.round(height * dpr);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");

  for (const tile of tiles) {
    const bitmap = await loadBitmap(tile.dataUrl);
    const sx = Math.max(0, Math.round((pageLeft - tile.pageX) * dpr));
    const sw = Math.min(Math.round(width * dpr), bitmap.width - sx);
    const dy = Math.round((tile.pageY - pageTop) * dpr);
    if (sw <= 0) continue;
    ctx.drawImage(bitmap, sx, 0, sw, bitmap.height, 0, dy, sw, bitmap.height);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  await downloadBlob(blob, filename);
  return { ok: true };
}

// --- GIF: tabCapture のライブストリームからフレームをサンプリングしてエンコード ---
async function startRecording({ streamId }) {
  if (recording) {
    return { ok: false, error: "既に録画中です" };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener("loadedmetadata", resolve, { once: true });
  });

  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();

  recording = { stream, video, canvas, ctx, gif, width, height, frameCount: 0 };

  recording.intervalId = setInterval(() => {
    captureGifFrame();
    if (recording && recording.frameCount >= GIF_MAX_FRAMES) {
      finishRecording().then((result) => {
        chrome.runtime.sendMessage({ type: "RECORDING_AUTO_STOPPED", result });
      });
    }
  }, GIF_FRAME_INTERVAL_MS);

  return { ok: true };
}

function captureGifFrame() {
  const { ctx, canvas, video, gif, width, height } = recording;
  ctx.drawImage(video, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const palette = quantize(imageData.data, GIF_PALETTE_SIZE);
  const index = applyPalette(imageData.data, palette);
  gif.writeFrame(index, width, height, {
    palette,
    delay: GIF_FRAME_INTERVAL_MS,
  });
  recording.frameCount++;
}

async function finishRecording() {
  if (!recording) return { ok: false, error: "録画されていません" };
  clearInterval(recording.intervalId);
  recording.stream.getTracks().forEach((t) => t.stop());

  const { gif, frameCount } = recording;
  recording = null;

  if (frameCount === 0) {
    return { ok: false, error: "フレームが取得できませんでした" };
  }
  gif.finish();
  const blob = new Blob([gif.bytes()], { type: "image/gif" });
  return { ok: true, blob, frameCount };
}

async function stopRecording({ filename }) {
  const result = await finishRecording();
  if (!result.ok) return result;
  await downloadBlob(result.blob, filename);
  return { ok: true, frameCount: result.frameCount };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;

  (async () => {
    switch (message.type) {
      case "PROCESS_CROP":
        sendResponse(await processCrop(message));
        break;
      case "PROCESS_TILES":
        sendResponse(await processTiles(message));
        break;
      case "START_RECORDING":
        sendResponse(await startRecording(message));
        break;
      case "STOP_RECORDING":
        sendResponse(await stopRecording(message));
        break;
      default:
        break;
    }
  })().catch((err) => {
    console.error("[offscreen] error handling", message?.type, err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});
