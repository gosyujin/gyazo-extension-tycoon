// Offscreen document: DOM/Canvas/MediaStream が必要な重い処理を一手に引き受ける。
// - PNG: キャプチャ済み data URL のトリミング・タイル結合
// - GIF: tabCapture の MediaStream からライブでフレームをサンプリングし、
//   実際のエンコード(quantize/applyPalette/writeFrame)は gif-worker.js に委譲する
// - 最終ファイルの chrome.downloads.download 呼び出し
//
// gifenc(GIFエンコード)は gif-worker.js 内でのみ読み込む。理由は下記
// startRecording() 手前のコメント、および gif-worker.js 冒頭のコメント参照。

const LOG_PREFIX = "[offscreen]";
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// GIFフレームのサンプリング間隔(ms、目標値)。captureVisibleTabの連続呼び出し
// (実質2fps程度が上限)より滑らかにするため、tabCaptureのライブストリームから
// 直接サンプリングする。あくまで setInterval に渡す目標値であり、実際の間隔は
// 下記 captureGifFrame() 内で計測して各フレームの delay に反映する(理由はそちら参照)。
// エンコードを gif-worker.js に切り出してメインスレッドの負荷を drawImage/getImageData
// だけに減らせたため、以前の60ms(目標約16.6fps)から33ms(目標約30fps、tabCaptureの
// 一般的な映像フレームレートに合わせた値)に短縮した。容量よりなめらかさを優先する方針。
const GIF_FRAME_INTERVAL_MS = 33;
// 録画の暴走防止用の暫定上限(フレーム数)。目標間隔通りに進めば約90秒
// (GIF_FRAME_INTERVAL_MS短縮に合わせて、時間の上限が変わらないよう比例して増やした)。
const GIF_MAX_FRAMES = 2700;
// quantize()(パレット再計算)は全ピクセルを見るため重く、毎フレーム行うと
// それ自体がWorker側の処理時間を延ばし、エンコードがサンプリングに追いつかなくなる
// 原因になる。数フレームに1回だけ再計算し、間のフレームは同じパレットを
// applyPalette() で使い回すことで、Workerの実効スループットを上げる
// (色の正確さより滑らかさを優先する方針)。
const GIF_PALETTE_REFRESH_INTERVAL = 10;
// getImageData/quantize/applyPalette は処理コストがピクセル数に比例するため、
// フルページ(高dpr環境では実質4Kクラスの映像)をそのまま処理すると1フレームの
// エンコード時間が長くなり、Worker側のバックログ(下記MAX_PENDING_FRAMES参照)が
// 溜まりやすくなる。そのため長辺がこの値を超える場合は、GIFに焼き込む前に
// このサイズまで縮小してからエンコードする(画質より滑らかさを優先)。
const GIF_MAX_DIMENSION = 960;
// エンコード(Worker側)がフレームサンプリングに追いつかない場合、投げたフレームの
// うちまだWorkerが処理していないものの数(バックログ)。これを無制限に溜めると、
// 1フレームあたり数MB(例: 960x540のRGBAで約2MB)のピクセルデータが際限なく
// メモリに積み上がり、長時間の録画でタブがクラッシュしかねない。そのため
// バックログがこの値を超えている間はメインスレッド側の drawImage/getImageData 自体を
// 一時的にスキップする(=実効フレームレートがWorkerの処理速度に合わせて自動的に
// 下がる)。スキップした分の経過時間は次に実際に送ったフレームのdelayに正しく
// 反映されるため(lastFrameAtの更新をスキップ時は行わない)、再生速度自体はズレない。
const MAX_PENDING_FRAMES = 120;

let recording = null; // { stream, video, canvas, ctx, worker, intervalId, frameCount, pendingFrames, width, height }

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
// rect/viewportWidth/viewportHeight が渡された場合(矩形選択・要素選択からの録画
// 開始)は、映像内の該当領域だけを毎フレーム切り出す。渡されなければタブ全体を録画する。
//
// クロップ座標は rect(CSS px, ビューポート相対)を dpr 倍するのではなく、
// 「映像の実解像度 / 選択時のビューポートCSS pxサイズ」を実測した比率で変換する。
// captureVisibleTab(PNG側で使用)は仕様上 devicePixelRatio 込みの実ピクセル解像度を
// 返すことが保証されているが、tabCapture の getUserMedia 映像の解像度は必ずしも
// devicePixelRatio と同じ倍率になるとは限らない(実機検証で dpr 倍だとズレることが
// 確認された)。実測比率を使えば、映像の実解像度がどうであっても正しくクロップできる。
//
// それでもなお、矩形/要素選択からの録画で実機検証のたびに横方向のクロップずれが
// 報告され続けた。考えられる原因は、getUserMedia に解像度の制約(width/height)を
// 一切指定していないため、Chrome側が実際のタブサイズと無関係な解像度で映像を
// 用意し(内部的なレターボックス/パディングが入るなど)、映像のどの矩形が
// 実際のページのどの範囲に対応するのかが単純な比例計算では表せなくなっている
// 可能性があること。そのため、rect付きの録画(選択範囲の録画)では
// minWidth=maxWidth / minHeight=maxHeight を選択時のビューポートサイズ×dpr で
// 明示的に指定し、PNG側(captureVisibleTab)と同じ「devicePixelRatio込みの実ピクセル
// 解像度」で映像が用意されるよう強制する。その上で、実際に得られた
// videoWidth/videoHeight を使った実測比率でのクロップ計算(上記)は保険として
// 残す(要求した解像度が何らかの理由でそのまま通らなかった場合でも、実際の
// 映像サイズを基準にする限り破綻しないため)。
async function startRecording({ streamId, rect, viewportWidth, viewportHeight, dpr }) {
  if (recording) {
    log("startRecording called while already recording");
    return { ok: false, error: "既に録画中です" };
  }

  log("startRecording", { streamId, rect, viewportWidth, viewportHeight, dpr });

  const videoConstraints = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
    },
  };
  if (rect && viewportWidth && viewportHeight) {
    const targetWidth = Math.round(viewportWidth * (dpr || 1));
    const targetHeight = Math.round(viewportHeight * (dpr || 1));
    Object.assign(videoConstraints.mandatory, {
      minWidth: targetWidth,
      maxWidth: targetWidth,
      minHeight: targetHeight,
      maxHeight: targetHeight,
    });
    log("requesting exact capture resolution", { targetWidth, targetHeight });
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: videoConstraints,
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
    const scaleX = videoWidth / viewportWidth;
    const scaleY = videoHeight / viewportHeight;
    const sx = Math.max(0, Math.round(rect.left * scaleX));
    const sy = Math.max(0, Math.round(rect.top * scaleY));
    const sw = Math.min(Math.round(rect.width * scaleX), videoWidth - sx);
    const sh = Math.min(Math.round(rect.height * scaleY), videoHeight - sy);
    log("crop bounds", { videoWidth, videoHeight, viewportWidth, viewportHeight, scaleX, scaleY, sx, sy, sw, sh });
    if (sw <= 0 || sh <= 0) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: `録画範囲が不正です(sw=${sw}, sh=${sh})` };
    }
    crop = { sx, sy, sw, sh };
  }

  const sourceWidth = crop ? crop.sw : videoWidth;
  const sourceHeight = crop ? crop.sh : videoHeight;
  // 長辺が GIF_MAX_DIMENSION を超える場合は、以後のエンコード解像度そのものを
  // 縮小する(理由は定数定義部を参照)。canvasの出力サイズをここで縮めておけば、
  // captureGifFrame() の drawImage が縮小込みで描いてくれるため以降のコードは
  // 変更不要。
  const downscale = Math.min(1, GIF_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * downscale));
  const height = Math.max(1, Math.round(sourceHeight * downscale));
  log("recording resolution", { sourceWidth, sourceHeight, width, height, downscale });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // GIFエンコード(quantize/applyPalette/writeFrame)は専用Workerに完全に委譲する。
  // 理由: これらはピクセル数に比例して重く、メインスレッド(フレームサンプリングと
  // 同じスレッド)で同期的に行うと、重い処理が走っている間サンプリングの setInterval
  // 自体が止まり、周期的なカクつきの原因になっていた(詳細は gif-worker.js 冒頭参照)。
  const worker = new Worker(new URL("./gif-worker.js", import.meta.url), { type: "module" });
  worker.onerror = (event) => {
    console.error(LOG_PREFIX, "gif-worker error", event.message, event);
  };
  try {
    await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.data?.type === "initDone") {
          worker.removeEventListener("message", onMessage);
          resolve();
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", reject, { once: true });
      worker.postMessage({ type: "init", paletteRefreshInterval: GIF_PALETTE_REFRESH_INTERVAL });
    });
  } catch (err) {
    worker.terminate();
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  recording = {
    stream,
    video,
    canvas,
    ctx,
    worker,
    crop,
    width,
    height,
    frameCount: 0, // メインスレッドが取り込んでWorkerに送ったフレーム数
    pendingFrames: 0, // まだWorkerがエンコードし終えていないフレーム数(バックログ)
    // 各フレームのdelayを実測するための直前フレーム時刻(理由はcaptureGifFrame参照)。
    lastFrameAt: performance.now(),
  };

  worker.addEventListener("message", (event) => {
    if (event.data?.type === "frameDone" && recording) {
      recording.pendingFrames = Math.max(0, recording.pendingFrames - 1);
    }
  });

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
  // Workerのエンコードがサンプリングに追いつかず、投げたフレームが溜まりすぎている
  // 場合は、メモリを無制限に消費しないようこのティックの取り込み自体をスキップする。
  // lastFrameAt を更新しないため、次に実際に送るフレームのdelayにはスキップした分の
  // 経過時間が正しく含まれ、GIFの再生速度は実時間からズレない(録画実効fpsが
  // Workerの処理速度に自動的に合わせて下がるだけ)。
  if (recording.pendingFrames >= MAX_PENDING_FRAMES) {
    log("encode backlog too large, skipping this frame", recording.pendingFrames);
    return;
  }

  const { ctx, video, width, height, crop, worker } = recording;
  if (crop) {
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  } else {
    ctx.drawImage(video, 0, 0, width, height);
  }
  const imageData = ctx.getImageData(0, 0, width, height);

  // delay は GIF_FRAME_INTERVAL_MS 固定ではなく実測の経過時間を使う。
  // 処理が目標間隔を超えて実際の間隔が伸びた場合でも固定値のまま記録すると、
  // GIF再生時間が実際の録画時間より短くなり「早送り」に見えるバグがあったため
  // (このバグの詳細はREADMEの実装ログ参照)。
  const now = performance.now();
  const elapsedMs = now - recording.lastFrameAt;
  recording.lastFrameAt = now;

  recording.pendingFrames++;
  // imageData.data.buffer は transfer するとこのスレッドでは使えなくなるが、
  // 次のティックで getImageData が新しいバッファを返すので問題ない(コピー不要)。
  worker.postMessage(
    { type: "frame", buffer: imageData.data.buffer, width, height, delay: Math.max(20, Math.round(elapsedMs)) },
    [imageData.data.buffer]
  );
  recording.frameCount++;
  if (recording.frameCount % 20 === 0) {
    log("captured", recording.frameCount, "frames so far (encode backlog:", recording.pendingFrames, ")");
  }
}

async function finishRecording() {
  if (!recording) {
    log("finishRecording called but nothing is recording");
    return { ok: false, error: "録画されていません" };
  }
  clearInterval(recording.intervalId);
  recording.stream.getTracks().forEach((t) => t.stop());

  const { worker, frameCount } = recording;
  log("finishRecording, frameCount=", frameCount, "encode backlog=", recording.pendingFrames);

  // finish を送る時点までにキューイングした "frame" メッセージは、Worker内で
  // メッセージ到着順に同期処理されるため、Workerがそれらをすべて処理し終えてから
  // "done" が返ってくる(=バックログがあっても取りこぼされない)。
  const bytes = await new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data?.type === "done") {
        worker.removeEventListener("message", onMessage);
        resolve(event.data.bytes);
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", reject, { once: true });
    worker.postMessage({ type: "finish" });
  });
  worker.terminate();
  recording = null;

  if (frameCount === 0) {
    return { ok: false, error: "フレームが取得できませんでした" };
  }
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
