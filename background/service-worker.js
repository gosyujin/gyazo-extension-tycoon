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

// ファイル名に使うサイト識別子。ドメイン名の "." を "_" に置換する
// (example.com → example_com、先頭の www. は落とす)。ファイル名に使えない文字は
// "_" に潰し、URLが取れない/http(s)以外のページは scheme 名(file など)か "unknown" にする。
function siteSlug(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return u.protocol.replace(":", "") || "unknown";
    }
    const host = u.host.replace(/^www\./, "");
    return host.replace(/[^A-Za-z0-9-]/g, "_") || "unknown";
  } catch {
    return "unknown";
  }
}

function timestampedFilename(ext, url) {
  const d = new Date();
  const ts =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `GyazoExtensionTycoon/${siteSlug(url)}-${ts}.${ext}`;
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

// ダウンロード開始時にChromeが出す「ダウンロードバブル/シェルフ」は、キーボードフォーカスを
// 奪うため、ショートカットでの連続撮影が止まってしまう。そこで、拡張機能自身が起こした
// ダウンロードの間だけ chrome.downloads.setUiOptions で標準のダウンロードUIを隠す
// ("downloads.ui" 権限が必要)。ユーザー自身の他のダウンロードまで隠しっぱなしに
// ならないよう、完了(または失敗/タイムアウト)したら必ず戻す。
const DOWNLOAD_UI_RESTORE_TIMEOUT_MS = 15000;
let downloadUiSuppressCount = 0;

async function setDownloadUiEnabled(enabled) {
  if (!chrome.downloads.setUiOptions) return;
  try {
    await chrome.downloads.setUiOptions({ enabled });
  } catch (err) {
    console.warn(LOG_PREFIX, "setUiOptions failed", err);
  }
}

async function suppressDownloadUi() {
  downloadUiSuppressCount++;
  if (downloadUiSuppressCount === 1) await setDownloadUiEnabled(false);
}

async function restoreDownloadUi() {
  downloadUiSuppressCount = Math.max(0, downloadUiSuppressCount - 1);
  if (downloadUiSuppressCount === 0) await setDownloadUiEnabled(true);
}

// サービスワーカーがダウンロード中に破棄されると「隠したまま」になりうるため、
// 起動のたびに必ず有効に戻しておく(隠すのはこの拡張機能だけなので安全)。
setDownloadUiEnabled(true);

// ダウンロードの終了(完了/失敗/タイムアウト)を待つ。戻り値は
// { ok: boolean, error?: string, filename?: string }(filename は実際に保存されたフルパス)。
// onChanged の登録前に終わっていた場合に備え、登録直後に一度 search で現状も確認する。
function waitForDownloadEnd(downloadId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };
    const inspect = async (fallback) => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.state === "complete") return finish({ ok: true, filename: item.filename });
        if (item?.state === "interrupted") {
          return finish({ ok: false, error: item.error || "UNKNOWN", filename: item.filename });
        }
      } catch (err) {
        console.warn(LOG_PREFIX, "downloads.search failed", err);
      }
      if (fallback) finish(fallback);
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      const state = delta.state && delta.state.current;
      if (state === "complete" || state === "interrupted") inspect();
    };
    const timer = setTimeout(
      () => inspect({ ok: false, error: "時間内に完了しませんでした" }),
      DOWNLOAD_UI_RESTORE_TIMEOUT_MS
    );
    chrome.downloads.onChanged.addListener(onChanged);
    inspect();
  });
}

// ダウンロードを開始する。finished はダウンロード終了時に解決される Promise
// (呼び出し元をブロックしないよう、await せず必要なら then で受ける)。
async function startDownload(url, filename) {
  log("downloading", filename);
  await suppressDownloadUi();
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
  } catch (err) {
    await restoreDownloadUi();
    throw err;
  }
  log("download started", filename, "downloadId=", downloadId);
  const finished = waitForDownloadEnd(downloadId).then(async (end) => {
    await restoreDownloadUi();
    log("download ended", downloadId, end);
    return end;
  });
  return { downloadId, finished };
}

// --- ダウンロード結果のトースト表示 ---
// 撮影・保存が終わったら、操作中のページの右上などに目立たないトーストを出して
// 「フォルダを表示」「画像をコピー」を選べるようにする(content script 側の
// showToast 参照)。トーストを出せないページ(chrome:// など)では通知にフォールバックする。

// すでに content script がいるタブにはそのままメッセージを送る。再注入すると
// content script の二重注入ガードが選択状態を解除してしまうため、受信側がいない
// (=メッセージが失敗した)ときだけ注入する。
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/content-script.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// payload: { ok, title, detail?, downloadId?, image? }。tabId が無い/トーストを出せない
// ときは通知にフォールバックする。
async function reportToast(tabId, payload) {
  let shown = false;
  if (tabId != null) {
    try {
      const res = await sendToContentScript(tabId, { type: "SHOW_TOAST", ...payload });
      shown = !!res?.ok;
    } catch (err) {
      log("toast failed, falling back to notification", err?.message || err);
    }
  }
  if (!shown) {
    const text = payload.detail ? `${payload.title}(${payload.detail})` : payload.title;
    notify(text, { isError: !payload.ok });
  }
}

function reportFailure(tabId, error) {
  return reportToast(tabId, { ok: false, title: "保存に失敗しました", detail: String(error) });
}

function basename(path) {
  return String(path ?? "").split(/[\\/]/).pop();
}

// ダウンロードを開始し、終了したらトーストで成功/失敗を知らせる。
// label: 保存したものの名前(フォールバック通知の文言用)。
// image: 「画像をコピー」の元画像({ dataUrl } か { blobUrl })。GIF など非対応のときは省略。
// extra: トーストの補足(フレーム数など)。
async function saveFile(url, filename, { tabId, label, image, extra } = {}) {
  const { downloadId, finished } = await startDownload(url, filename);
  finished
    .then((end) => {
      if (end.ok) {
        const name = basename(end.filename) || basename(filename);
        return reportToast(tabId, {
          ok: true,
          title: "ダウンロードしました",
          detail: extra ? `${name} ${extra}` : name,
          downloadId,
          image,
          label,
        });
      }
      return reportToast(tabId, {
        ok: false,
        title: "ダウンロードに失敗しました",
        detail: end.error,
      });
    })
    .catch((err) => console.error(LOG_PREFIX, "failed to report download result", err));
  return downloadId;
}

// トーストの「画像をコピー」用。content script からは offscreen が作った Blob URL を
// 直接読めないので、ここで取得して base64 の data URL にして返す。
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchImageAsDataUrl(url) {
  if (typeof url !== "string" || !url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) {
    throw new Error("不正な画像URLです");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました(${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

// 撮影のたびに残っているトーストが画像に写り込まないよう、撮影前に消してもらう。
// content script がいないタブでは何もしない。
async function dismissToastBeforeCapture(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PREPARE_CAPTURE" });
  } catch {
    // content script 未注入(トーストも無い)なら問題なし
  }
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
  await dismissToastBeforeCapture(tab.id);
  const dataUrl = await captureActiveTabPng(tab.windowId);
  await saveFile(dataUrl, timestampedFilename("png", tab.url), {
    tabId: tab.id,
    label: "表示中のページ",
    image: { dataUrl },
  });
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
    await saveFile(result.dataUrl, timestampedFilename("png", tab.url), {
      tabId: tab.id,
      label: "動画フレーム",
      image: { dataUrl: result.dataUrl },
    });
  } else {
    await reportFailure(tab.id, `動画フレーム: ${result?.error ?? "不明なエラー"}`);
  }
  return result;
}

async function startRecordingVisiblePage({ lightweight, fps, diffThreshold, size } = {}) {
  const tab = await getActiveTab();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  log("got tabCapture streamId, starting offscreen recording (visible page)");
  const result = await sendToOffscreen({ type: "START_RECORDING", streamId, lightweight, fps, diffThreshold, size });
  if (result?.ok) {
    await rememberRecordingUrl(tab.url);
    setRecordingBadge(true);
  } else {
    notify(`録画の開始に失敗しました: ${result?.error ?? "不明なエラー"}`, { isError: true });
  }
  return { recordingState: { isRecording: !!result?.ok, frameCount: 0, elapsedMs: 0 }, result };
}

// トーストを出す先(いま見ているタブ)。取れなければ null(通知にフォールバックする)。
async function activeTabIdOrNull() {
  try {
    return (await getActiveTab()).id;
  } catch {
    return null;
  }
}

function formatSizeMb(bytes) {
  return typeof bytes === "number" ? ` ${(bytes / (1024 * 1024)).toFixed(1)}MB` : "";
}

// 録画対象のURLは録画開始時に保存しておき、停止/自動停止時に参照する
// (停止時のアクティブタブは録画中のタブと別のことがあり、サービスワーカーの
// 変数も再起動で消えるため、chrome.storage.session に持つ)。
async function rememberRecordingUrl(url) {
  await chrome.storage.session.set({ recordingUrl: url ?? "" });
}

async function recordedUrl() {
  const { recordingUrl } = await chrome.storage.session.get("recordingUrl");
  return recordingUrl;
}

async function stopRecordingAndSave() {
  const filename = timestampedFilename("gif", await recordedUrl());
  const result = await sendToOffscreen({ type: "STOP_RECORDING", filename });
  setRecordingBadge(false);
  const tabId = await activeTabIdOrNull();
  if (result?.ok && result.url) {
    const lightenedNote = result.lightened ? " ※軽量化" : "";
    await saveFile(result.url, filename, {
      tabId,
      label: "GIF",
      // GIF(アニメーション)はクリップボードに画像としてコピーできないので image は渡さない
      extra: `(${result.frameCount}フレーム${formatSizeMb(result.size)})${lightenedNote}`,
    });
  } else {
    await reportFailure(tabId, `GIF: ${result?.error ?? "不明なエラー"}`);
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
        const filename = timestampedFilename("png", tab.url ?? sender.url);
        const result = await sendToOffscreen({
          type: "PROCESS_CROP",
          dataUrl,
          rect: message.rect,
          dpr: message.dpr,
          filename,
          masks: message.masks,
        });
        if (result?.ok && result.url) {
          await saveFile(result.url, filename, {
            tabId: tab.id,
            label: "選択範囲",
            image: { blobUrl: result.url },
          });
        } else {
          await reportFailure(tab.id, result?.error ?? "不明なエラー");
        }
        sendResponse(result);
        break;
      }

      case "TILES_READY": {
        // フルページ or ビューポートより大きい要素選択: タイル結合
        const filename = timestampedFilename("png", sender.tab?.url ?? sender.url);
        const result = await sendToOffscreen({
          type: "PROCESS_TILES",
          tiles: message.tiles,
          region: message.region,
          dpr: message.dpr,
          filename,
          masks: message.masks,
        });
        const tabId = sender.tab?.id ?? null;
        if (result?.ok && result.url) {
          await saveFile(result.url, filename, {
            tabId,
            label: "ページ全体",
            image: { blobUrl: result.url },
          });
        } else {
          await reportFailure(tabId, result?.error ?? "不明なエラー");
        }
        sendResponse(result);
        break;
      }

      // --- トーストのボタン操作(content script から) ---
      case "SHOW_DOWNLOAD": {
        // 「フォルダを表示」: ダウンロードしたファイルをOSのファイラーで開く
        if (typeof message.downloadId === "number") chrome.downloads.show(message.downloadId);
        sendResponse({ ok: true });
        break;
      }

      case "FETCH_IMAGE_DATA_URL": {
        // 「画像をコピー」: offscreen が作った Blob URL の画像を content script に渡す
        try {
          sendResponse({ ok: true, dataUrl: await fetchImageAsDataUrl(message.url) });
        } catch (err) {
          log("FETCH_IMAGE_DATA_URL failed", err?.message || err);
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
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
        const tabId = await activeTabIdOrNull();
        if (message.result?.ok && message.result.url) {
          const lightenedNote = message.result.lightened ? " ※軽量化" : "";
          await saveFile(message.result.url, timestampedFilename("gif", await recordedUrl()), {
            tabId,
            label: "GIF(上限に達したため自動停止)",
            extra: `(上限到達で自動停止${formatSizeMb(message.result.size)})${lightenedNote}`,
          });
        } else {
          await reportFailure(tabId, `自動停止時のGIF保存: ${message.result?.error ?? "不明なエラー"}`);
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
          masks: message.masks,
        });
        if (result?.ok) {
          await rememberRecordingUrl(tab.url ?? sender.url);
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
