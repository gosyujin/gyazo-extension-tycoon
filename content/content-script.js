// Content script: 矩形選択・要素選択のオーバーレイUIと、フルページ/大きい要素向けの
// 「スクロールしながら分割キャプチャ」ループを担当する。
// 実際の画素データの加工(トリミング・結合)は行わない(offscreen document の責務)。
(() => {
  // 二重注入ガード(popupから複数回 START_* が来ても安全にする)
  if (window.__gyazoExtTycoonInjected) {
    window.__gyazoExtTycoonReinit?.();
    return;
  }
  window.__gyazoExtTycoonInjected = true;

  const LOG_PREFIX = "[content-script]";
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  const MAX_TILES = 80; // フルページ撮影の安全上限(暴走防止の暫定値。要調整)
  const SCROLL_SETTLE_MS = 300; // スクロール後、再描画/遅延読み込みを待つ暫定ディレイ

  let overlayEl = null;
  let selectionBoxEl = null;
  let highlightEl = null;
  let dragStart = null;
  let keydownHandler = null;

  function cleanupOverlay() {
    overlayEl?.remove();
    highlightEl?.remove();
    overlayEl = null;
    selectionBoxEl = null;
    highlightEl = null;
    dragStart = null;
    if (keydownHandler) {
      window.removeEventListener("keydown", keydownHandler, true);
      keydownHandler = null;
    }
  }

  function notifyCancelled(reason) {
    log("cancelled:", reason);
    chrome.runtime.sendMessage({ type: "SELECTION_CANCELLED" });
  }

  function armEscapeToCancel(onCancel) {
    keydownHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanupOverlay();
        onCancel("Escape");
      }
    };
    window.addEventListener("keydown", keydownHandler, true);
  }

  // --- 矩形選択 ---
  function startRectSelect() {
    log("startRectSelect");
    cleanupOverlay();
    overlayEl = document.createElement("div");
    overlayEl.className = "gyazo-ext-tycoon-overlay";
    selectionBoxEl = document.createElement("div");
    selectionBoxEl.className = "gyazo-ext-tycoon-selection-box";
    overlayEl.appendChild(selectionBoxEl);
    document.documentElement.appendChild(overlayEl);

    armEscapeToCancel(notifyCancelled);

    const onMouseDown = (e) => {
      dragStart = { x: e.clientX, y: e.clientY };
      updateSelectionBox(e.clientX, e.clientY);
      selectionBoxEl.style.display = "block";
    };
    const onMouseMove = (e) => {
      if (!dragStart) return;
      updateSelectionBox(e.clientX, e.clientY);
    };
    const onMouseUp = (e) => {
      if (!dragStart) return;
      const rect = rectFromPoints(dragStart, { x: e.clientX, y: e.clientY });
      overlayEl.removeEventListener("mousedown", onMouseDown);
      overlayEl.removeEventListener("mousemove", onMouseMove);
      overlayEl.removeEventListener("mouseup", onMouseUp);
      cleanupOverlay();
      if (rect.width < 2 || rect.height < 2) {
        notifyCancelled(`rect too small (drag needed): ${JSON.stringify(rect)}`);
        return;
      }
      log("rect selected", rect);
      chrome.runtime
        .sendMessage({
          type: "CROP_SELECTION_READY",
          rect,
          dpr: window.devicePixelRatio || 1,
        })
        .then((res) => log("CROP_SELECTION_READY response", res))
        .catch((err) => console.error(LOG_PREFIX, "CROP_SELECTION_READY failed", err));
    };

    function updateSelectionBox(x, y) {
      const rect = rectFromPoints(dragStart, { x, y });
      selectionBoxEl.style.left = `${rect.left}px`;
      selectionBoxEl.style.top = `${rect.top}px`;
      selectionBoxEl.style.width = `${rect.width}px`;
      selectionBoxEl.style.height = `${rect.height}px`;
    }

    overlayEl.addEventListener("mousedown", onMouseDown);
    overlayEl.addEventListener("mousemove", onMouseMove);
    overlayEl.addEventListener("mouseup", onMouseUp);
  }

  function rectFromPoints(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x);
    const height = Math.abs(a.y - b.y);
    return { left, top, width, height };
  }

  // --- 要素選択 ---
  function startElementSelect() {
    log("startElementSelect");
    cleanupOverlay();
    highlightEl = document.createElement("div");
    highlightEl.className = "gyazo-ext-tycoon-highlight";
    document.documentElement.appendChild(highlightEl);

    armEscapeToCancel(notifyCancelled);

    const onMouseMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === highlightEl) return;
      const r = target.getBoundingClientRect();
      highlightEl.style.left = `${r.left}px`;
      highlightEl.style.top = `${r.top}px`;
      highlightEl.style.width = `${r.width}px`;
      highlightEl.style.height = `${r.height}px`;
      highlightEl.dataset.targetTag = target.tagName;
    };

    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = document.elementFromPoint(e.clientX, e.clientY);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("click", onClick, true);
      cleanupOverlay();
      if (!target) {
        notifyCancelled("no element under click point");
        return;
      }
      log("element clicked", target.tagName, target.className);
      await handleElementSelected(target);
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("click", onClick, true);
  }

  async function handleElementSelected(target) {
    const dpr = window.devicePixelRatio || 1;
    const rect = target.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;

    const fitsInViewport =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= viewportHeight &&
      rect.right <= viewportWidth;

    log("handleElementSelected", { rect, viewportWidth, viewportHeight, fitsInViewport });

    if (fitsInViewport) {
      chrome.runtime
        .sendMessage({
          type: "CROP_SELECTION_READY",
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          dpr,
        })
        .then((res) => log("CROP_SELECTION_READY response", res))
        .catch((err) => console.error(LOG_PREFIX, "CROP_SELECTION_READY failed", err));
      return;
    }

    // ビューポートより大きい/画面外にはみ出す要素は、フルページと同じ
    // タイル分割撮影で対応する(ページ絶対座標に変換して範囲指定)。
    const pageLeft = rect.left + window.scrollX;
    const pageTop = rect.top + window.scrollY;
    await runTileCapture({
      pageLeft,
      pageTop,
      width: rect.width,
      height: rect.height,
    });
  }

  // --- フルページ撮影 ---
  async function startFullpageCapture() {
    log("startFullpageCapture");
    const doc = document.documentElement;
    const width = doc.clientWidth;
    const height = Math.max(
      doc.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    await runTileCapture({ pageLeft: 0, pageTop: 0, width, height });
  }

  function waitFor(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // captureVisibleTab はレート制限(実質2回/秒程度)にかかることがある。
  // background 側でも間隔調整しているが、念のためここでもリトライする。
  async function captureNowWithRetry(maxRetries = 4) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await chrome.runtime.sendMessage({ type: "CAPTURE_NOW" });
      if (res?.dataUrl) return res.dataUrl;
      log("CAPTURE_NOW failed, will retry", { attempt, error: res?.error });
      await waitFor(400 + attempt * 200);
    }
    return null;
  }

  // pageLeft/pageTop/width/height はページ絶対座標(CSS px)。
  // スクロールしながら captureVisibleTab を繰り返し、タイル一覧を
  // background(→offscreen)に送って結合・保存してもらう。
  async function runTileCapture({ pageLeft, pageTop, width, height }) {
    log("runTileCapture start", { pageLeft, pageTop, width, height });
    const dpr = window.devicePixelRatio || 1;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    const tiles = [];
    let currentY = pageTop;
    const endY = pageTop + height;
    let lastScrollY = null;

    for (let i = 0; i < MAX_TILES && currentY < endY; i++) {
      window.scrollTo(pageLeft, currentY);
      await waitFor(SCROLL_SETTLE_MS);
      const actualScrollY = window.scrollY;

      if (actualScrollY === lastScrollY) break; // これ以上スクロールできない(下端に到達)
      lastScrollY = actualScrollY;

      const dataUrl = await captureNowWithRetry();
      if (!dataUrl) {
        log(`tile ${i + 1} capture failed after retries, skipping`, { actualScrollY });
      } else {
        tiles.push({ dataUrl, pageY: actualScrollY, pageX: window.scrollX });
      }
      log(`captured tile ${i + 1}`, { actualScrollY, dataUrlLength: dataUrl?.length });

      if (actualScrollY + viewportHeight >= endY) break;
      currentY = actualScrollY + viewportHeight;
    }

    window.scrollTo(originalScrollX, originalScrollY);

    if (tiles.length === 0) {
      notifyCancelled("no tiles captured");
      return;
    }

    log(`sending ${tiles.length} tiles to background`);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TILES_READY",
        tiles,
        region: { pageLeft, pageTop, width, height, viewportWidth, viewportHeight },
        dpr,
      });
      log("TILES_READY response", res);
    } catch (err) {
      console.error(LOG_PREFIX, "TILES_READY failed", err);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "START_RECT_SELECT":
        startRectSelect();
        sendResponse({ ok: true });
        break;
      case "START_ELEMENT_SELECT":
        startElementSelect();
        sendResponse({ ok: true });
        break;
      case "START_FULLPAGE_CAPTURE":
        startFullpageCapture().then(() => sendResponse({ ok: true }));
        return true;
      default:
        break;
    }
  });

  window.__gyazoExtTycoonReinit = () => {
    cleanupOverlay();
  };
})();
