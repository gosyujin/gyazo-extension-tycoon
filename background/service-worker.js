// Background service worker: 各コンテキスト(popup / content script / offscreen)からの
// メッセージを中継し、拡張API(tabs.captureVisibleTab / scripting / tabCapture / offscreen)を
// 一元的に呼び出すオーケストレーター。
// - Blob/canvas/ダウンロード処理は行わない(offscreen document の責務)。
// - DOM操作(オーバーレイ・スクロール)は行わない(content script の責務)。

const OFFSCREEN_URL = "offscreen/offscreen.html";

let recordingState = {
  isRecording: false,
  tabId: null,
};

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

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing && existing.length > 0) return;

  // getContexts is unavailable on older Chrome; hasDocument is the fallback.
  if (!existing && chrome.offscreen.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification:
      "タブ録画(MediaRecorder)、キャプチャ画像のトリミング/結合、GIFエンコード、ファイルダウンロードのため",
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

async function captureActiveTabPng(windowId) {
  // captureVisibleTab はそのタブの実ピクセル解像度(devicePixelRatio込み)で
  // PNG の data URL を返す。
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return; // offscreen宛は無視

  (async () => {
    switch (message.type) {
      // --- popup からの操作開始要求 ---
      case "CAPTURE_VISIBLE_PAGE": {
        const tab = await getActiveTab();
        const dataUrl = await captureActiveTabPng(tab.windowId);
        await chrome.downloads.download({
          url: dataUrl,
          filename: timestampedFilename("png"),
          saveAs: false,
        });
        sendResponse({ ok: true });
        break;
      }

      case "START_RECT_SELECT": {
        const tab = await getActiveTab();
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content-script.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content/overlay.css"],
        });
        await chrome.tabs.sendMessage(tab.id, { type: "START_RECT_SELECT" });
        sendResponse({ ok: true });
        break;
      }

      case "START_ELEMENT_SELECT": {
        const tab = await getActiveTab();
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content-script.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content/overlay.css"],
        });
        await chrome.tabs.sendMessage(tab.id, {
          type: "START_ELEMENT_SELECT",
        });
        sendResponse({ ok: true });
        break;
      }

      case "START_FULLPAGE_CAPTURE": {
        const tab = await getActiveTab();
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content-script.js"],
        });
        await chrome.tabs.sendMessage(tab.id, {
          type: "START_FULLPAGE_CAPTURE",
        });
        sendResponse({ ok: true });
        break;
      }

      // --- content script からの結果通知 ---
      case "CAPTURE_NOW": {
        // フルページ/要素タイル撮影のループ中、content script が1タイルぶん
        // 撮影してほしいときに呼ぶ。呼び出し元のタブを対象にする。
        const tab = sender.tab;
        const dataUrl = await captureActiveTabPng(tab.windowId);
        sendResponse({ dataUrl });
        break;
      }

      case "CROP_SELECTION_READY": {
        // 矩形選択 or ビューポート内に収まる要素選択: 単発キャプチャ+クロップ
        const tab = sender.tab;
        const dataUrl = await captureActiveTabPng(tab.windowId);
        const result = await sendToOffscreen({
          type: "PROCESS_CROP",
          dataUrl,
          rect: message.rect,
          dpr: message.dpr,
          filename: timestampedFilename("png"),
        });
        sendResponse(result);
        break;
      }

      case "TILES_READY": {
        // フルページ or ビューポートより大きい要素選択: タイル結合
        const result = await sendToOffscreen({
          type: "PROCESS_TILES",
          tiles: message.tiles,
          region: message.region,
          dpr: message.dpr,
          filename: timestampedFilename("png"),
        });
        sendResponse(result);
        break;
      }

      case "SELECTION_CANCELLED": {
        sendResponse({ ok: true });
        break;
      }

      // --- 録画(GIF)関連 ---
      case "RECORDING_AUTO_STOPPED": {
        // offscreen 側の安全上限(GIF_MAX_FRAMES)到達による自動停止の通知
        recordingState = { isRecording: false, tabId: null };
        sendResponse({ ok: true });
        break;
      }

      case "GET_RECORDING_STATE": {
        sendResponse(recordingState);
        break;
      }

      case "TOGGLE_RECORDING": {
        if (recordingState.isRecording) {
          const result = await sendToOffscreen({
            type: "STOP_RECORDING",
            filename: timestampedFilename("gif"),
          });
          recordingState = { isRecording: false, tabId: null };
          sendResponse({ recordingState, result });
        } else {
          const tab = await getActiveTab();
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tab.id,
          });
          await ensureOffscreenDocument();
          const result = await sendToOffscreen({
            type: "START_RECORDING",
            streamId,
          });
          if (result && result.ok) {
            recordingState = { isRecording: true, tabId: tab.id };
          }
          sendResponse({ recordingState, result });
        }
        break;
      }

      default:
        break;
    }
  })().catch((err) => {
    console.error("[service-worker] error handling", message?.type, err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // sendResponse を非同期に呼ぶことを伝える
});
