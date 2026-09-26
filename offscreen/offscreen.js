// Offscreen document: DOM/Canvas/MediaStream が必要な重い処理を一手に引き受ける。
// - PNG: キャプチャ済み data URL のトリミング・タイル結合
// - GIF: tabCapture の MediaStream からライブでフレームをサンプリングしてエンコード
// - 最終ファイルの chrome.downloads.download 呼び出し
//
// gifenc は PNG のみのフローには不要なので、動的 import で GIF 録画開始時にのみ
// 読み込む(gifenc 側に問題があっても PNG 系の機能を道連れにしないため)。

const LOG_PREFIX = "[offscreen]";
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// GIFフレームのサンプリング間隔(ms、目標値)。captureVisibleTabの連続呼び出し
// (実質2fps程度が上限)より滑らかにするため、tabCaptureのライブストリームから
// 直接サンプリングする。あくまで setInterval に渡す目標値であり、実際の間隔は
// 下記 captureGifFrame() 内で計測して各フレームの delay に反映する(理由はそちら参照)。
// 値は暫定。容量よりなめらかさを優先する方針で意図的に小さめにしている。
const GIF_FRAME_INTERVAL_MS = 60;
// 録画の暴走防止用の暫定上限(フレーム数)。目標間隔通りに進めば約90秒。
const GIF_MAX_FRAMES = 1500;
const GIF_PALETTE_SIZE = 256;
// quantize()(パレット再計算)は全ピクセルを見るため重く、毎フレーム行うと
// それ自体が実際のフレーム間隔を目標値より延ばしてしまう。数フレームに1回だけ
// 再計算し、間のフレームは同じパレットを applyPalette() で使い回すことで
// 実際の間隔を目標値に近づける(色の正確さより滑らかさを優先する方針)。
const GIF_PALETTE_REFRESH_INTERVAL = 5;

let recording = null; // { stream, video, canvas, ctx, gif, intervalId, frameCount, width, height }

// 重要: offscreen document には chrome.downloads が生えていない(呼ぶと
// "Cannot read properties of undefined (reading 'download')" になる)。
// そのため download 自体は background 側で行い、ここでは Blob を
// Blob URL 化して返すだけにする。Blob URL は同一オリジン(この拡張機能)
// であれば background からも参照できるが、この offscreen document が
// 閉じられると無効になるため、background が chrome.downloads.download を
// 呼び終えるまでは revoke しない(念のための保険として一定時間後に revoke する)。
function blobToObjectUrl(blob, label) {
  log("blobToObjectUrl", label, `${blob.size} bytes`, blob.type);
  if (blob.size === 0) {
    throw new Error(`生成されたファイルが空です(${label})`);
  }
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
}

async function loadBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

// --- PNG: 矩形/ビューポート内要素のトリミング ---
async function processCrop({ dataUrl, rect, dpr, filename }) {
  log("processCrop", { rect, dpr, filename });
  const bitmap = await loadBitmap(dataUrl);
  const sx = Math.max(0, Math.round(rect.left * dpr));
  const sy = Math.max(0, Math.round(rect.top * dpr));
  const sw = Math.min(Math.round(rect.width * dpr), bitmap.width - sx);
  const sh = Math.min(Math.round(rect.height * dpr), bitmap.height - sy);
  log("crop bounds", { bitmapW: bitmap.width, bitmapH: bitmap.height, sx, sy, sw, sh });

  if (sw <= 0 || sh <= 0) {
    throw new Error(
      `クロップ範囲が不正です(sw=${sw}, sh=${sh}, bitmap=${bitmap.width}x${bitmap.height})`
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const url = blobToObjectUrl(blob, filename);
  return { ok: true, url };
}

// --- PNG: フルページ/大きい要素のタイル結合 ---
async function processTiles({ tiles, region, dpr, filename }) {
  log("processTiles", { tileCount: tiles.length, region, dpr, filename });
  const { pageLeft, pageTop, width, height } = region;
  const canvasWidth = Math.round(width * dpr);
  const canvasHeight = Math.round(height * dpr);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");

  let drawnTiles = 0;
  for (const tile of tiles) {
    if (!tile.dataUrl) {
      log("skipping tile with missing dataUrl (capture likely failed/rate-limited)", {
        pageY: tile.pageY,
      });
      continue;
    }
    const bitmap = await loadBitmap(tile.dataUrl);
    const sx = Math.max(0, Math.round((pageLeft - tile.pageX) * dpr));
    const sw = Math.min(Math.round(width * dpr), bitmap.width - sx);
    const dy = Math.round((tile.pageY - pageTop) * dpr);
    if (sw <= 0) {
      log("skipping tile with non-positive width", { sx, sw, pageY: tile.pageY });
      continue;
    }
    ctx.drawImage(bitmap, sx, 0, sw, bitmap.height, 0, dy, sw, bitmap.height);
    drawnTiles++;
  }
  log("drew", drawnTiles, "of", tiles.length, "tiles");

  if (drawnTiles === 0) {
    throw new Error("結合できるタイルがありませんでした");
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const url = blobToObjectUrl(blob, filename);
  return { ok: true, url };
}

// --- GIF: tabCapture のライブストリームからフレームをサンプリングしてエンコード ---
// rect/dpr が渡された場合(矩形選択・要素選択からの録画開始)は、processCrop() と
// 同じ考え方(CSS px の rect に dpr を掛けて実ピクセル座標に変換)で映像内の
// 該当領域だけを毎フレーム切り出す。渡されなければタブ全体を録画する。
async function startRecording({ streamId, rect, dpr }) {
  if (recording) {
    log("startRecording called while already recording");
    return { ok: false, error: "既に録画中です" };
  }

  log("startRecording", { streamId, rect, dpr });
  const { GIFEncoder, quantize, applyPalette } = await import(
    "../vendor/gifenc/gifenc.esm.js"
  );

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });
  log("got MediaStream", stream.id, "tracks=", stream.getTracks().length);

  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener("loadedmetadata", resolve, { once: true });
  });

  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  log("video ready", { videoWidth, videoHeight });
  if (!videoWidth || !videoHeight) {
    stream.getTracks().forEach((t) => t.stop());
    return {
      ok: false,
      error: `録画対象の映像サイズが取得できません(${videoWidth}x${videoHeight})`,
    };
  }

  let crop = null;
  if (rect) {
    const sx = Math.max(0, Math.round(rect.left * dpr));
    const sy = Math.max(0, Math.round(rect.top * dpr));
    const sw = Math.min(Math.round(rect.width * dpr), videoWidth - sx);
    const sh = Math.min(Math.round(rect.height * dpr), videoHeight - sy);
    log("crop bounds", { videoWidth, videoHeight, sx, sy, sw, sh });
    if (sw <= 0 || sh <= 0) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: `録画範囲が不正です(sw=${sw}, sh=${sh})` };
    }
    crop = { sx, sy, sw, sh };
  }

  const width = crop ? crop.sw : videoWidth;
  const height = crop ? crop.sh : videoHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();

  recording = {
    stream,
    video,
    canvas,
    ctx,
    gif,
    crop,
    width,
    height,
    frameCount: 0,
    palette: null,
    // 各フレームのdelayを実測するための直前フレーム時刻(理由はcaptureGifFrame参照)。
    lastFrameAt: performance.now(),
    quantize,
    applyPalette,
  };

  recording.intervalId = setInterval(() => {
    captureGifFrame();
    if (recording && recording.frameCount >= GIF_MAX_FRAMES) {
      log("max frames reached, auto-stopping");
      finishRecording().then((result) => {
        // Blob は chrome.runtime.sendMessage で JSON シリアライズできないため
        // 必ず URL 文字列に変換してから送る。
        if (result.ok) {
          const url = blobToObjectUrl(result.blob, "auto-stopped-recording.gif");
          chrome.runtime.sendMessage({
            type: "RECORDING_AUTO_STOPPED",
            result: { ok: true, url, frameCount: result.frameCount },
          });
        } else {
          chrome.runtime.sendMessage({ type: "RECORDING_AUTO_STOPPED", result });
        }
      });
    }
  }, GIF_FRAME_INTERVAL_MS);

  return { ok: true };
}

function captureGifFrame() {
  const { ctx, video, gif, width, height, crop } = recording;
  if (crop) {
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  } else {
    ctx.drawImage(video, 0, 0, width, height);
  }
  const imageData = ctx.getImageData(0, 0, width, height);

  // パレットは毎フレームではなく数フレームに1回だけ再計算する(理由は定数定義部を参照)。
  if (!recording.palette || recording.frameCount % GIF_PALETTE_REFRESH_INTERVAL === 0) {
    recording.palette = recording.quantize(imageData.data, GIF_PALETTE_SIZE);
  }
  const index = recording.applyPalette(imageData.data, recording.palette);

  // delay は GIF_FRAME_INTERVAL_MS 固定ではなく実測の経過時間を使う。
  // quantize等の処理が目標間隔を超えて実際の間隔が伸びた場合でも固定値のまま
  // 記録すると、GIF再生時間が実際の録画時間より短くなり「早送り」に見える
  // バグがあったため(このバグの詳細はREADMEの実装ログ参照)。
  const now = performance.now();
  const elapsedMs = now - recording.lastFrameAt;
  recording.lastFrameAt = now;

  gif.writeFrame(index, width, height, {
    palette: recording.palette,
    delay: Math.max(20, Math.round(elapsedMs)),
  });
  recording.frameCount++;
  if (recording.frameCount % 20 === 0) log("captured", recording.frameCount, "frames so far");
}

async function finishRecording() {
  if (!recording) {
    log("finishRecording called but nothing is recording");
    return { ok: false, error: "録画されていません" };
  }
  clearInterval(recording.intervalId);
  recording.stream.getTracks().forEach((t) => t.stop());

  const { gif, frameCount } = recording;
  recording = null;
  log("finishRecording, frameCount=", frameCount);

  if (frameCount === 0) {
    return { ok: false, error: "フレームが取得できませんでした" };
  }
  gif.finish();
  const bytes = gif.bytes();
  log("gif encoded", bytes.length, "bytes");
  const blob = new Blob([bytes], { type: "image/gif" });
  return { ok: true, blob, frameCount };
}

async function stopRecording({ filename }) {
  const result = await finishRecording();
  if (!result.ok) return result;
  const url = blobToObjectUrl(result.blob, filename);
  return { ok: true, url, frameCount: result.frameCount };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;
  log("received", message.type);

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
      case "GET_RECORDING_STATE":
        sendResponse({ isRecording: !!recording, frameCount: recording?.frameCount ?? 0 });
        break;
      default:
        log("unhandled message type", message.type);
        break;
    }
  })().catch((err) => {
    console.error(LOG_PREFIX, "error handling", message?.type, err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});

log("offscreen document loaded and listener registered");
