// Background service worker: 各コンテキスト(popup / content script / offscreen)からの
// メッセージを中継し、拡張API(tabs.captureVisibleTab / scripting / tabCapture / offscreen)を
// 一元的に呼び出すオーケストレーター。
// - Blob/canvas/ダウンロード処理は行わない(offscreen document の責務)。
// - DOM操作(オーバーレイ・スクロール)は行わない(content script の責務)。
//
// 注意: このファイル(サービスワーカー)は MV3 の仕様上、アイドル状態が続くと
// 破棄され、次のイベントで再起動される。トップレベルの `let` 変数は再起動で
// リセットされるため、「録画中かどうか」のような状態はここでは保持せず、
// 常に offscreen document (再起動されない) 側の実態を問い合わせて判定する。

const OFFSCREEN_URL = "offscreen/offscreen.html";
const LOG_PREFIX = "[service-worker]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function notify(message, { isError = false } = {}) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: isError ? "Gyazo Extension Tycoon - エラー" : "Gyazo Extension Tycoon",
    message,
  });
}

// popup を閉じている間(矩形/要素選択からの録画開始など)も録画中であることが
// わかるよう、ツールバーアイコンにバッジを出す。
function setRecordingBadge(isRecording) {
  chrome.action.setBadgeBackgroundColor({ color: "#eb5757" });
  chrome.action.setBadgeText({ text: isRecording ? "REC" : "" });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function timestampedFilename(ext) {
  const d = new Date();
  const ts =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `GyazoExtensionTycoon/capture-${ts}.${ext}`;
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return existing.length > 0;
  }
  // getContexts はやや新しい API なので、無い場合は hasDocument にフォールバックする。
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  log("creating offscreen document");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification:
      "タブ録画(MediaStream)、キャプチャ画像のトリミング/結合、GIFエンコード、ファイルダウンロードのため",
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) throw new Error("アクティブなタブが見つかりません");
  return tab;
}

// chrome.tabs.captureVisibleTab には呼び出しレート制限があり(実質2回/秒程度)、
// それを超えると失敗して undefined が返る(例外にはならない)。フルページ撮影のように
// 連続で呼ぶ場合に備え、直近の呼び出しから最低間隔をあけるようにする。
const MIN_CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;

async function captureActiveTabPng(windowId) {
  const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastCaptureAt = Date.now();
  // captureVisibleTab はそのタブの実ピクセル解像度(devicePixelRatio込み)で
  // PNG の data URL を返す。
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  if (!dataUrl) {
    throw new Error(
      "captureVisibleTab が失敗しました(呼び出しレート制限の可能性があります)"
    );
  }
  return dataUrl;
}

async function downloadUrl(url, filename) {
  log("downloading", filename);
  const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  log("download started", filename, "downloadId=", downloadId);
  return downloadId;
}

async function injectContentScript(tab, { withOverlayCss = false } = {}) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/content-script.js"],
  });
  if (withOverlayCss) {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/overlay.css"],
    });
  }
}

// 以下は popup のボタンクリックと chrome.commands のキーボードショートカットの
// どちらからも同じ動作になるよう、実際の処理をここに共通化しておく
// ([popup/popup.js]・chrome.commands.onCommand の両方から呼ばれる)。

async function captureVisiblePage() {
  const tab = await getActiveTab();
  const dataUrl = await captureActiveTabPng(tab.windowId);
  await downloadUrl(dataUrl, timestampedFilename("png"));
  notify("表示中のページを保存しました");
}

async function startRectSelectOnActiveTab() {
  const tab = await getActiveTab();
  await injectContentScript(tab, { withOverlayCss: true });
  await chrome.tabs.sendMessage(tab.id, { type: "START_RECT_SELECT" });
}

async function startElementSelectOnActiveTab() {
  const tab = await getActiveTab();
  await injectContentScript(tab, { withOverlayCss: true });
  await chrome.tabs.sendMessage(tab.id, { type: "START_ELEMENT_SELECT" });
}

async function startFullpageCaptureOnActiveTab() {
  const tab = await getActiveTab();
  await injectContentScript(tab);
  await chrome.tabs.sendMessage(tab.id, { type: "START_FULLPAGE_CAPTURE" });
}

// 動画フレームの撮影自体(canvasへのdrawImage・PNG化)は content script 側で行う
// (video要素の実ピクセルを直接扱えるDOM操作のため、offscreen document 経由の
// スクリーン撮影は不要)。ここでは content script を注入してメッセージを送り、
// 返ってきた data URL をそのままダウンロードするだけ。
async function captureVideoFrameOnActiveTab() {
  const tab = await getActiveTab();
  await injectContentScript(tab);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_VIDEO_FRAME" });
  if (result?.ok && result.dataUrl) {
    await downloadUrl(result.dataUrl, timestampedFilename("png"));
    notify("動画フレームを保存しました");
  } else {
    notify(`動画フレームの保存に失敗しました: ${result?.error ?? "不明なエラー"}`, {
      isError: true,
    });
  }
  return result;
}

async function startRecordingVisiblePage({ lightweight, fps, diffThreshold, size } = {}) {
  const tab = await getActiveTab();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  log("got tabCapture streamId, starting offscreen recording (visible page)");
  const result = await sendToOffscreen({ type: "START_RECORDING", streamId, lightweight, fps, diffThreshold, size });
  if (result?.ok) {
    setRecordingBadge(true);
  } else {
    notify(`録画の開始に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
  }
  return { recordingState: { isRecording: !!result?.ok, frameCount: 0, elapsedMs: 0 }, result };
}

function formatSizeMb(bytes) {
  return typeof bytes === "number" ? ` ${(bytes / (1024 * 1024)).toFixed(1)}MB` : "";
}

async function stopRecordingAndSave() {
  const filename = timestampedFilename("gif");
  const result = await sendToOffscreen({ type: "STOP_RECORDING", filename });
  setRecordingBadge(false);
  if (result?.ok && result.url) {
    await downloadUrl(result.url, filename);
    const lightenedNote = result.lightened ? " ※軽量化しました" : "";
    notify(`GIFを保存しました(${result.frameCount}フレーム${formatSizeMb(result.size)})${lightenedNote}`);
  } else {
    notify(`GIFの保存に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
  }
  return { recordingState: { isRecording: false }, result };
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  log("-> offscreen", message.type);
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    ...message,
  });
  log("<- offscreen", message.type, result);
  return result;
}

// 録画中かどうか・フレーム数・経過時間は offscreen document に実態を聞きに行く
// (background 側では持たない)。popup/ツールバーの「nフレーム / x秒」表示はこれを
// ポーリングして更新する。
async function queryRecordingState() {
  if (!(await hasOffscreenDocument())) return { isRecording: false, frameCount: 0, elapsedMs: 0 };
  const result = await sendToOffscreen({ type: "GET_RECORDING_STATE" });
  return {
    isRecording: !!result?.isRecording,
    frameCount: result?.frameCount ?? 0,
    elapsedMs: result?.elapsedMs ?? 0,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return; // offscreen宛は無視
  log("received", message.type, "from", sender.tab ? `tab#${sender.tab.id}` : "extension page");

  (async () => {
    switch (message.type) {
      // --- popup / キーボードショートカットからの操作開始要求 ---
      case "CAPTURE_VISIBLE_PAGE": {
        await captureVisiblePage();
        sendResponse({ ok: true });
        break;
      }

      case "START_RECT_SELECT": {
        await startRectSelectOnActiveTab();
        sendResponse({ ok: true });
        break;
      }

      case "START_ELEMENT_SELECT": {
        await startElementSelectOnActiveTab();
        sendResponse({ ok: true });
        break;
      }

      case "START_FULLPAGE_CAPTURE": {
        await startFullpageCaptureOnActiveTab();
        sendResponse({ ok: true });
        break;
      }

      case "CAPTURE_VIDEO_FRAME": {
        sendResponse(await captureVideoFrameOnActiveTab());
        break;
      }

      // --- content script からの結果通知 ---
      case "CAPTURE_NOW": {
        // フルページ/要素タイル撮影のループ中、content script が1タイルぶん
        // 撮影してほしいときに呼ぶ。呼び出し元のタブを対象にする。
        // レート制限等で失敗しても例外にせず、content script 側でリトライ
        // 判断できるよう { dataUrl: null, error } を返す。
        const tab = sender.tab;
        try {
          const dataUrl = await captureActiveTabPng(tab.windowId);
          sendResponse({ dataUrl });
        } catch (err) {
          log("CAPTURE_NOW failed", err.message);
          sendResponse({ dataUrl: null, error: err.message });
        }
        break;
      }

      case "CROP_SELECTION_READY": {
        // 矩形選択 or ビューポート内に収まる要素選択: 単発キャプチャ+クロップ
        const tab = sender.tab;
        const dataUrl = await captureActiveTabPng(tab.windowId);
        const filename = timestampedFilename("png");
        const result = await sendToOffscreen({
          type: "PROCESS_CROP",
          dataUrl,
          rect: message.rect,
          dpr: message.dpr,
          filename,
        });
        if (result?.ok && result.url) {
          await downloadUrl(result.url, filename);
          notify("選択範囲を保存しました");
        } else {
          notify(`保存に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
        }
        sendResponse(result);
        break;
      }

      case "TILES_READY": {
        // フルページ or ビューポートより大きい要素選択: タイル結合
        const filename = timestampedFilename("png");
        const result = await sendToOffscreen({
          type: "PROCESS_TILES",
          tiles: message.tiles,
          region: message.region,
          dpr: message.dpr,
          filename,
        });
        if (result?.ok && result.url) {
          await downloadUrl(result.url, filename);
          notify("ページ全体を保存しました");
        } else {
          notify(`保存に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
        }
        sendResponse(result);
        break;
      }

      case "SELECTION_CANCELLED": {
        log("selection cancelled by user/content-script");
        notify(
          message.message ?? "選択がキャンセルされました(範囲が小さすぎるか Esc が押されました)"
        );
        sendResponse({ ok: true });
        break;
      }

      // --- 録画(GIF)関連 ---
      case "RECORDING_AUTO_STOPPED": {
        // offscreen 側の安全上限(GIF_MAX_FRAMES)到達による自動停止の通知
        log("recording auto-stopped (max frames reached)", message.result);
        setRecordingBadge(false);
        if (message.result?.ok && message.result.url) {
          await downloadUrl(message.result.url, timestampedFilename("gif"));
          const lightenedNote = message.result.lightened ? " ※軽量化しました" : "";
          notify(
            `上限フレーム数に達したため自動的に録画を停止し、GIFを保存しました${formatSizeMb(message.result.size)}${lightenedNote}`
          );
        } else {
          notify(`自動停止時の保存に失敗しました: ${message.result?.error ?? "不明なエラー"}`, { isError: true });
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_RECORDING_STATE": {
        const state = await queryRecordingState();
        setRecordingBadge(state.isRecording);
        sendResponse(state);
        break;
      }

      // 表示中のページ(タブ全体)をそのまま録画開始する。
      case "START_RECORDING_VISIBLE": {
        sendResponse(
          await startRecordingVisiblePage({
            lightweight: message.lightweight,
            fps: message.fps,
            diffThreshold: message.diffThreshold,
            size: message.size,
          })
        );
        break;
      }

      // 矩形選択・要素選択(ビューポートに収まるもの)からの録画開始。
      // content script 側で選択が完了すると送られてくる。
      case "RECT_READY_FOR_RECORDING": {
        const tab = sender.tab;
        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: tab.id,
        });
        log("got tabCapture streamId, starting offscreen recording (rect)", message.rect);
        const result = await sendToOffscreen({
          type: "START_RECORDING",
          streamId,
          rect: message.rect,
          viewportWidth: message.viewportWidth,
          viewportHeight: message.viewportHeight,
          dpr: message.dpr,
          lightweight: message.lightweight,
          fps: message.fps,
          diffThreshold: message.diffThreshold,
          size: message.size,
        });
        if (result?.ok) {
          setRecordingBadge(true);
          notify("録画を開始しました(ページ上のツールバーまたは拡張機能アイコンから停止できます)");
        } else {
          notify(`録画の開始に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
        }
        sendResponse(result);
        break;
      }

      case "STOP_RECORDING": {
        sendResponse(await stopRecordingAndSave());
        break;
      }

      default:
        log("unhandled message type", message.type);
        break;
    }
  })().catch((err) => {
    console.error(LOG_PREFIX, "error handling", message?.type, err);
    notify(`エラーが発生しました(${message?.type}): ${err?.message || err}`, {
      isError: true,
    });
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // sendResponse を非同期に呼ぶことを伝える
});

// キーボードショートカット(chrome://extensions/shortcuts でユーザーが割り当てる)。
// manifest.json の "commands" で名前だけ宣言し、実際のキー割り当てはChrome標準の
// 画面に任せる方針(独自のオプション画面は作らない)。popupのボタンと全く同じ
// 処理を呼ぶことで、ショートカットからも「ワンアクションで起動」できるようにする。
chrome.commands.onCommand.addListener((command) => {
  log("command", command);
  (async () => {
    switch (command) {
      case "capture-rect":
        await startRectSelectOnActiveTab();
        break;
      case "capture-element":
        await startElementSelectOnActiveTab();
        break;
      case "capture-visible":
        await captureVisiblePage();
        break;
      case "capture-fullpage":
        await startFullpageCaptureOnActiveTab();
        break;
      case "capture-video-frame":
        await captureVideoFrameOnActiveTab();
        break;
      case "record-visible":
        await startRecordingVisiblePage();
        break;
      case "record-stop":
        await stopRecordingAndSave();
        break;
      default:
        log("unhandled command", command);
    }
  })().catch((err) => {
    console.error(LOG_PREFIX, "command failed", command, err);
    notify(`ショートカットの実行に失敗しました(${command}): ${err?.message || err}`, {
      isError: true,
    });
  });
});
