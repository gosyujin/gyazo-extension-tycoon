// Content script: 矩形選択・要素選択のオーバーレイUIと、フルページ/大きい要素向けの
// 「スクロールしながら分割キャプチャ」ループを担当する。
// 実際の画素データの加工(トリミング・結合)は行わない(offscreen document の責務)。
//
// 矩形選択・要素選択は「範囲を選ぶ」と「その範囲に対して何をするか(画像保存/録画)」を
// 分離している。選択が確定すると、選択範囲のそばに「画像保存」「録画開始/停止」の
// ツールバーを表示し、Escで解除するまで同じ選択を保持する。保持している間は
// 「画像保存」を何度でも押して連続保存できる。
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

  let overlayEl = null; // 矩形ドラッグ中だけ存在する全面オーバーレイ(ドラッグ確定後は外す)
  let selectionBoxEl = null;
  let highlightEl = null;
  let toolbarEl = null;
  let dragStart = null;
  let keydownHandler = null;
  // ツールバーの「nフレーム / x秒」表示を更新するポーリング(showActionToolbar内で
  // 開始・停止する)。toolbarEl 自体を消しても setInterval は止まらないため、
  // cleanupOverlay からも明示的に止められるようモジュールスコープに置く。
  let toolbarPollTimer = null;

  function cleanupOverlay() {
    overlayEl?.remove();
    selectionBoxEl?.remove();
    highlightEl?.remove();
    toolbarEl?.remove();
    overlayEl = null;
    selectionBoxEl = null;
    highlightEl = null;
    toolbarEl = null;
    dragStart = null;
    if (keydownHandler) {
      window.removeEventListener("keydown", keydownHandler, true);
      keydownHandler = null;
    }
    if (toolbarPollTimer) {
      clearInterval(toolbarPollTimer);
      toolbarPollTimer = null;
    }
  }

  // message: ユーザー向けの通知文言(省略時はbackground側の汎用文言を使う)。
  function notifyCancelled(reason, message) {
    log("cancelled:", reason);
    chrome.runtime.sendMessage({ type: "SELECTION_CANCELLED", message });
  }

  // Escキーで選択を解除する。onEscapeは任意の後処理(ログ出力など)。
  function armEscapeToCancel(onEscape) {
    keydownHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanupOverlay();
        onEscape?.();
      }
    };
    window.addEventListener("keydown", keydownHandler, true);
  }

  // --- 選択確定後の操作ツールバー(矩形選択・要素選択で共通) ---
  // canRecord=false の場合は録画ボタンを disabled にし、recordDisabledReason を
  // title(ツールチップ)に表示する。
  // outlineEl: 選択範囲を示す枠(selectionBoxEl/highlightEl)。録画中はこの枠自体が
  // 録画映像に写り込んでしまう(枠はちょうど選択範囲の境界に重なっており、録画対象の
  // 領域の内側にはみ出て描画されるため)ので、録画中は非表示にする。
  function showActionToolbar(anchorRect, { onSave, canRecord, onStartRecording, recordDisabledReason, outlineEl }) {
    toolbarEl?.remove();
    toolbarEl = document.createElement("div");
    toolbarEl.className = "gyazo-ext-tycoon-toolbar";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "画像保存";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      // 録画と同様、選択枠(outlineEl)自体が撮影範囲の境界に重なって描画されている
      // ため、キャプチャ中は非表示にしないと枠線がそのまま画像に写り込む。
      if (outlineEl) outlineEl.style.visibility = "hidden";
      try {
        await onSave();
      } catch (err) {
        console.error(LOG_PREFIX, "save failed", err);
      } finally {
        if (outlineEl) outlineEl.style.visibility = "";
        saveBtn.disabled = false;
      }
    });
    toolbarEl.appendChild(saveBtn);

    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.textContent = "録画開始";
    toolbarEl.appendChild(recordBtn);

    // 録画開始からの「nフレーム / x秒」表示。画像保存(1回きりの単発処理)には
    // 付けない(録画のように継続する状態ではないため表示する意味が薄い)。
    const counterEl = document.createElement("span");
    counterEl.className = "gyazo-ext-tycoon-toolbar-counter";
    toolbarEl.appendChild(counterEl);

    // 「動画を軽量化する」: オンにすると、録画終了時にGIFが5MB程度を超えていた場合
    // フレーム数(なめらかさ)を保ったまま解像度・色数を下げて再エンコードする
    // (詳細は offscreen/gif-worker.js 参照)。録画中に設定を変えられると開始時の
    // 前提と食い違うため、録画開始〜終了の間は disabled にする。
    const lightweightLabel = document.createElement("label");
    lightweightLabel.className = "gyazo-ext-tycoon-toolbar-lightweight";
    const lightweightCheckbox = document.createElement("input");
    lightweightCheckbox.type = "checkbox";
    lightweightLabel.appendChild(lightweightCheckbox);
    lightweightLabel.appendChild(document.createTextNode("軽量化"));
    toolbarEl.appendChild(lightweightLabel);

    function formatCounter(state) {
      if (!state?.isRecording) return "";
      const seconds = (state.elapsedMs ?? 0) / 1000;
      return `${state.frameCount ?? 0}フレーム / ${seconds.toFixed(1)}秒`;
    }

    async function fetchRecordingState() {
      try {
        return await chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" });
      } catch (err) {
        console.error(LOG_PREFIX, "GET_RECORDING_STATE failed", err);
        return null;
      }
    }

    // 実際に録画中かどうか・フレーム数・経過時間は offscreen document が真実の
    // 情報源なので、ボタンラベル・チェックボックスのdisabled・カウンター表示を
    // まとめてこの関数経由で同期させる。
    function applyRecordingState(state) {
      const isRecording = !!state?.isRecording;
      recordBtn.textContent = isRecording ? "録画停止" : "録画開始";
      lightweightCheckbox.disabled = isRecording;
      counterEl.textContent = formatCounter(state);
      if (isRecording) {
        if (!toolbarPollTimer) {
          toolbarPollTimer = setInterval(async () => {
            applyRecordingState(await fetchRecordingState());
          }, 500);
        }
      } else if (toolbarPollTimer) {
        clearInterval(toolbarPollTimer);
        toolbarPollTimer = null;
      }
    }

    if (!canRecord) {
      recordBtn.disabled = true;
      recordBtn.title = recordDisabledReason ?? "";
    } else {
      recordBtn.addEventListener("click", async () => {
        recordBtn.disabled = true;
        try {
          const state = await fetchRecordingState();
          if (state?.isRecording) {
            await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
            if (outlineEl) outlineEl.style.visibility = "";
          } else {
            if (outlineEl) outlineEl.style.visibility = "hidden";
            const result = await onStartRecording({ lightweight: lightweightCheckbox.checked });
            if (!result?.ok && outlineEl) outlineEl.style.visibility = ""; // 開始失敗時は表示を戻す
          }
        } catch (err) {
          console.error(LOG_PREFIX, "toggle recording failed", err);
          if (outlineEl) outlineEl.style.visibility = "";
        } finally {
          applyRecordingState(await fetchRecordingState());
          recordBtn.disabled = false;
        }
      });
      // ツールバー表示時点で(別経路から開始されて)既に録画中だった場合にも
      // 正しいラベル・カウンターで開始できるよう、実態を問い合わせて初期化する。
      fetchRecordingState().then(applyRecordingState);
    }

    document.documentElement.appendChild(toolbarEl);
    positionToolbar(toolbarEl, anchorRect);
  }

  // 選択範囲の下に置く。画面下端からはみ出す場合は上に置く。
  function positionToolbar(el, rect) {
    const margin = 6;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const left = Math.max(0, Math.min(rect.left, viewportWidth - el.offsetWidth));
    const below = rect.top + rect.height + margin;
    const fitsBelow = below + el.offsetHeight <= viewportHeight;
    const top = fitsBelow ? below : Math.max(0, rect.top - margin - el.offsetHeight);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // --- 矩形選択 ---
  function startRectSelect() {
    log("startRectSelect");
    cleanupOverlay();
    overlayEl = document.createElement("div");
    overlayEl.className = "gyazo-ext-tycoon-overlay";
    document.documentElement.appendChild(overlayEl);

    selectionBoxEl = document.createElement("div");
    selectionBoxEl.className = "gyazo-ext-tycoon-selection-box";
    document.documentElement.appendChild(selectionBoxEl);

    armEscapeToCancel(() => log("rect selection released via Escape"));

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
      dragStart = null;
      if (rect.width < 2 || rect.height < 2) {
        // ミスクリック程度の小さすぎるドラッグは無視し、同じ選択待機状態を保つ
        // (選択自体をキャンセルすると毎回popupから再度呼び出す必要が出るため)。
        selectionBoxEl.style.display = "none";
        return;
      }
      log("rect selected", rect);
      overlayEl.removeEventListener("mousedown", onMouseDown);
      overlayEl.removeEventListener("mousemove", onMouseMove);
      overlayEl.removeEventListener("mouseup", onMouseUp);
      lockRectSelection(rect);
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

  function lockRectSelection(rect) {
    // ドラッグ検出用の全面オーバーレイ(暗い背景・ページ操作をブロックする)は
    // 選択確定後は不要なので外す。選択枠とツールバーだけを残し、ページ自体は
    // 普通に操作できるようにする(録画中にページを操作したい場合もあるため)。
    overlayEl?.remove();
    overlayEl = null;
    selectionBoxEl.classList.add("gyazo-ext-tycoon-selection-box-locked");

    // 録画側のクロップは tabCapture 映像の実解像度をこのビューポートCSS pxサイズで
    // 割った比率で行う(offscreen.jsのstartRecording参照)。映像は実際に描画される
    // 領域(スクロールバー分を含む window.innerWidth/innerHeight)を基準にしているため、
    // ここも document.documentElement.clientWidth(スクロールバー分を除いた幅)ではなく
    // window.innerWidth を使う必要がある。片方だけ違う基準を使うと、縦横比が
    // 合わずクロップ範囲が横方向にだけずれる/広がるバグになる。
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    showActionToolbar(rect, {
      onSave: async () => {
        const res = await chrome.runtime.sendMessage({
          type: "CROP_SELECTION_READY",
          rect,
          dpr: window.devicePixelRatio || 1,
        });
        log("CROP_SELECTION_READY response", res);
      },
      canRecord: true,
      onStartRecording: ({ lightweight } = {}) =>
        chrome.runtime.sendMessage({
          type: "RECT_READY_FOR_RECORDING",
          rect,
          viewportWidth,
          viewportHeight,
          dpr: window.devicePixelRatio || 1,
          lightweight,
        }),
      outlineEl: selectionBoxEl,
    });
  }

  function rectFromPoints(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x);
    const height = Math.abs(a.y - b.y);
    return { left, top, width, height };
  }

  // --- 要素選択 ---
  // 要素の getBoundingClientRect() は、その要素自身に見た目の区切りが無い場合、
  // 実際に目に見えている内容(テキストや画像)より横に広いことがある(例: リストの
  // 1行が親コンテナいっぱいの幅を持つブロック要素で、中の文字はその一部しか
  // 占めていない場合、右側の余白ごと選択・録画されてしまう)。狭めるのは横幅のみに
  // 留める(報告された不具合はいずれも横方向のみだったため。縦方向まで狭めると
  // リストの行区切り線などとズレるリスクがあり、狙いに対してやり過ぎになる)。
  //
  // 「見た目の区切り」の判定は2段階の注意が必要だった(実機検証で判明):
  // - 単に backgroundColor が transparent でないだけでは不十分。多くのサイトは
  //   リストの各行に(周囲と同じ)明示的な背景色を指定しているだけのことが多く、
  //   その場合は周囲と区別がつかないため「視覚的な区切り」とは言えない。祖先を
  //   遡って実際に透けて見える背景色(実効背景色)と比較し、異なる場合のみ
  //   「区切りあり」とする。
  // - 上下の枠線(リストの行区切り線)は横幅には無関係なので見ない。横方向の区切り
  //   として数えるのは左右の枠線(と、周囲と異なる背景)のみ。
  function isTransparentColor(color) {
    return !color || color === "transparent" || color === "rgba(0, 0, 0, 0)";
  }

  function getEffectiveBackgroundColor(el) {
    let node = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!isTransparentColor(bg)) return bg;
      node = node.parentElement;
    }
    return "rgb(255, 255, 255)"; // フォールバック: 一般的なページ背景(白)と仮定
  }

  function hasDistinctBackground(el) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
    if (isTransparentColor(cs.backgroundColor)) return false;
    if (!el.parentElement) return true;
    return cs.backgroundColor !== getEffectiveBackgroundColor(el.parentElement);
  }

  function hasVisibleBorder(el, sides) {
    const cs = getComputedStyle(el);
    return sides.some((side) => {
      const width = parseFloat(cs[`border${side}Width`]);
      return width > 0 && cs[`border${side}Style`] !== "none" && !isTransparentColor(cs[`border${side}Color`]);
    });
  }

  // 要素自体が「横方向に」見た目の区切りを持つか。持つ場合はその要素の左右端を
  // そのまま「見た目の範囲」として扱う(狭めない)。
  function hasHorizontalBoxDecoration(el) {
    return hasDistinctBackground(el) || hasVisibleBorder(el, ["Left", "Right"]);
  }

  const REPLACED_TAGS = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "PICTURE"]);

  function collectVisualRects(node, rects) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent.trim()) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return;

    if (REPLACED_TAGS.has(node.tagName) || hasHorizontalBoxDecoration(node)) {
      // 画像等の置換要素、または横方向に見た目の区切りを持つ要素はそれ自体の箱を
      // 丸ごと使う(中身を個別に見て狭める必要はない)。
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
      return;
    }

    for (const child of node.childNodes) {
      collectVisualRects(child, rects);
    }
  }

  // 要素の「見た目で認識できる範囲」を返す(横幅のみ内容に合わせて狭める。
  // 縦方向は常に要素自体の箱をそのまま使う)。可視コンテンツが見つからない場合は
  // 元の getBoundingClientRect() にフォールバックする。
  function computeVisualRect(target) {
    const fullRect = target.getBoundingClientRect();
    if (hasHorizontalBoxDecoration(target)) return fullRect;

    const rects = [];
    collectVisualRects(target, rects);
    if (rects.length === 0) return fullRect;

    let left = Infinity;
    let right = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    return {
      left,
      top: fullRect.top,
      width: right - left,
      height: fullRect.height,
      right,
      bottom: fullRect.bottom,
    };
  }

  function startElementSelect() {
    log("startElementSelect");
    cleanupOverlay();
    highlightEl = document.createElement("div");
    highlightEl.className = "gyazo-ext-tycoon-highlight";
    document.documentElement.appendChild(highlightEl);

    armEscapeToCancel(() => log("element selection released via Escape"));

    const onMouseMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === highlightEl) return;
      const r = computeVisualRect(target);
      highlightEl.style.left = `${r.left}px`;
      highlightEl.style.top = `${r.top}px`;
      highlightEl.style.width = `${r.width}px`;
      highlightEl.style.height = `${r.height}px`;
      highlightEl.dataset.targetTag = target.tagName;
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = document.elementFromPoint(e.clientX, e.clientY);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("click", onClick, true);
      if (!target) {
        cleanupOverlay();
        notifyCancelled("no element under click point");
        return;
      }
      log("element clicked", target.tagName, target.className);
      lockElementSelection(target);
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("click", onClick, true);
  }

  function lockElementSelection(target) {
    const rect = computeVisualRect(target);
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const fitsInViewport =
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= viewportHeight &&
      rect.right <= viewportWidth;
    const pageLeft = rect.left + window.scrollX;
    const pageTop = rect.top + window.scrollY;

    log("lockElementSelection", { rect, viewportWidth, viewportHeight, fitsInViewport });

    highlightEl.classList.add("gyazo-ext-tycoon-highlight-locked");
    highlightEl.style.left = `${rect.left}px`;
    highlightEl.style.top = `${rect.top}px`;
    highlightEl.style.width = `${rect.width}px`;
    highlightEl.style.height = `${rect.height}px`;

    const rectPayload = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    // 録画のクロップ比率計算用は window.innerWidth を使う(理由はlockRectSelection参照)。
    // fitsInViewport の判定自体は要素が実際に描画され得る範囲(clientWidth)との
    // 比較のままでよいので、そちらの viewportWidth はそのまま残す。
    const captureViewportWidth = window.innerWidth;

    showActionToolbar(rect, {
      onSave: async () => {
        if (fitsInViewport) {
          const res = await chrome.runtime.sendMessage({
            type: "CROP_SELECTION_READY",
            rect: rectPayload,
            dpr: window.devicePixelRatio || 1,
          });
          log("CROP_SELECTION_READY response", res);
          return;
        }
        // ビューポートより大きい/画面外にはみ出す要素は、フルページと同じ
        // タイル分割撮影で対応する(ページ絶対座標に変換して範囲指定)。
        await runTileCapture({ pageLeft, pageTop, width: rect.width, height: rect.height });
      },
      canRecord: fitsInViewport,
      // GIF録画はライブ映像を毎フレーム切り出す都合上、フルページ撮影のような
      // スクロールしながらのタイル分割には対応できない(録画中にスクロール位置を
      // 動かすと録画内容自体が乱れる)。ビューポートに収まる要素のみ録画可能にする。
      recordDisabledReason: "選択した要素は画面からはみ出しているため録画できません(画像保存は可能です)",
      onStartRecording: ({ lightweight } = {}) =>
        chrome.runtime.sendMessage({
          type: "RECT_READY_FOR_RECORDING",
          rect: rectPayload,
          viewportWidth: captureViewportWidth,
          viewportHeight,
          dpr: window.devicePixelRatio || 1,
          lightweight,
        }),
      outlineEl: highlightEl,
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
      notifyCancelled("no tiles captured", "保存に失敗しました(タイル撮影に失敗しました)");
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
