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

  // --- マスク(黒塗り・モザイク) ---
  // 選択範囲の中の機微な情報を保存前に隠すための矩形。ここ(ページ上)で持つのは
  // 位置とプレビュー用のDOMだけで、実際の黒塗り・モザイクは撮影した画素データに対して
  // offscreen document 側で焼き込む(offscreen/offscreen.js の applyMasks 参照)。
  // 座標は選択枠と同じ position: fixed のビューポート座標(CSS px)。
  const MIN_MASK_SIZE = 4;
  let maskLayerEl = null; // プレビュー用のマスク要素を入れる全面コンテナ
  let masks = []; // [{ type: "black" | "mosaic", left, top, width, height, el }]
  let maskDrawing = null; // マスク描画モード中のみ { type, overlay }
  let recordingActive = false; // 録画中はマスクの追加・取消を無効にする(開始時の値で固定されるため)

  function ensureMaskLayer() {
    if (!maskLayerEl) {
      maskLayerEl = document.createElement("div");
      maskLayerEl.className = "gyazo-ext-tycoon-mask-layer";
      document.documentElement.appendChild(maskLayerEl);
    }
    return maskLayerEl;
  }

  function positionMaskEl(el, rect) {
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }

  function addMask(type, rect) {
    const el = document.createElement("div");
    el.className = `gyazo-ext-tycoon-mask gyazo-ext-tycoon-mask-${type}`;
    positionMaskEl(el, rect);
    ensureMaskLayer().appendChild(el);
    masks.push({ type, left: rect.left, top: rect.top, width: rect.width, height: rect.height, el });
    syncMaskButtons();
  }

  function undoLastMask() {
    const last = masks.pop();
    last?.el.remove();
    syncMaskButtons();
  }

  // offscreen に渡すマスク一覧。ビューポート内の単発キャプチャ・録画用(ビューポート座標)。
  function masksForViewport() {
    return masks.map(({ type, left, top, width, height }) => ({ type, left, top, width, height }));
  }

  // スクロールしながらのタイル撮影用(ページ絶対座標)。プレビューは画面に固定されているので、
  // 保存を押した時点のスクロール位置で変換する(見えている位置にマスクが掛かるように)。
  function masksForPage() {
    return masks.map(({ type, left, top, width, height }) => ({
      type,
      left: left + window.scrollX,
      top: top + window.scrollY,
      width,
      height,
    }));
  }

  function exitMaskMode() {
    maskDrawing?.overlay.remove();
    maskDrawing = null;
    syncMaskButtons();
  }

  // 「黒塗り」「モザイク」ボタンの押下状態と「取消」ボタンの有効/無効を現状に合わせる。
  function syncMaskButtons() {
    if (!toolbarEl) return;
    for (const btn of toolbarEl.querySelectorAll("[data-mask-type]")) {
      const active = maskDrawing?.type === btn.dataset.maskType;
      btn.classList.toggle("gyazo-ext-tycoon-toolbar-active", active);
      btn.disabled = recordingActive;
    }
    const undoBtn = toolbarEl.querySelector("[data-mask-undo]");
    if (undoBtn) undoBtn.disabled = recordingActive || masks.length === 0;
  }

  // ドラッグで矩形を描いてマスクを追加するモードに入る。連続して何個でも描け、
  // Esc(または同じボタンをもう一度)で抜ける。
  function enterMaskMode(type) {
    exitMaskMode();
    const overlay = document.createElement("div");
    overlay.className = "gyazo-ext-tycoon-mask-overlay";
    const draft = document.createElement("div");
    draft.className = `gyazo-ext-tycoon-mask gyazo-ext-tycoon-mask-${type} gyazo-ext-tycoon-mask-draft`;
    draft.style.display = "none";
    overlay.appendChild(draft);
    document.documentElement.appendChild(overlay);
    maskDrawing = { type, overlay };

    let start = null;
    overlay.addEventListener("mousedown", (e) => {
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      positionMaskEl(draft, rectFromPoints(start, start));
      draft.style.display = "block";
    });
    overlay.addEventListener("mousemove", (e) => {
      if (!start) return;
      positionMaskEl(draft, rectFromPoints(start, { x: e.clientX, y: e.clientY }));
    });
    overlay.addEventListener("mouseup", (e) => {
      if (!start) return;
      const rect = rectFromPoints(start, { x: e.clientX, y: e.clientY });
      start = null;
      draft.style.display = "none";
      // ミスクリック程度の小さすぎるドラッグは無視する
      if (rect.width >= MIN_MASK_SIZE && rect.height >= MIN_MASK_SIZE) {
        log("mask added", type, rect);
        addMask(type, rect);
      }
    });
    syncMaskButtons();
  }

  // fps・差分しきい値の入力欄は数値のみ・範囲内に丸める(popup/popup.jsと同じロジック。
  // ビルドツールを使わない方針のため、共有モジュール化はせずそれぞれのファイルに
  // 持たせている)。
  function clampFps(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 30;
    return Math.min(60, Math.max(1, n));
  }

  function clampDiffThreshold(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 24;
    return Math.min(255, Math.max(0, n));
  }

  // fps・差分しきい値・サイズは「最後に録画開始した時の値」を chrome.storage.local に
  // 保存し、次回ツールバー表示時のデフォルト値として復元する(popup/popup.jsと同じ
  // ロジック。共有モジュール化はせずそれぞれのファイルに持たせている)。
  const GIF_SETTINGS_STORAGE_KEY = "gifSettings";

  async function loadSavedGifSettings() {
    try {
      const stored = await chrome.storage.local.get(GIF_SETTINGS_STORAGE_KEY);
      const saved = stored?.[GIF_SETTINGS_STORAGE_KEY] ?? {};
      return {
        fps: clampFps(saved.fps),
        diffThreshold: clampDiffThreshold(saved.diffThreshold),
        size: ["large", "medium", "small"].includes(saved.size) ? saved.size : "large",
      };
    } catch (err) {
      console.error(LOG_PREFIX, "failed to load saved GIF settings", err);
      return { fps: 30, diffThreshold: 24, size: "large" };
    }
  }

  function saveGifSettings(settings) {
    chrome.storage.local.set({ [GIF_SETTINGS_STORAGE_KEY]: settings }).catch((err) => {
      console.error(LOG_PREFIX, "failed to save GIF settings", err);
    });
  }

  function cleanupOverlay() {
    overlayEl?.remove();
    selectionBoxEl?.remove();
    highlightEl?.remove();
    toolbarEl?.remove();
    exitMaskMode();
    maskLayerEl?.remove();
    maskLayerEl = null;
    masks = [];
    recordingActive = false;
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
        // マスク描画中のEscは、選択全体ではなく描画モードだけを抜ける
        if (maskDrawing) {
          exitMaskMode();
          return;
        }
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
    // 保存中にEscで cleanupOverlay() されて toolbarEl が null になっても、
    // finally で安全に表示を戻せるようローカル参照を持っておく。
    const bar = toolbarEl;

    // 撮影・録画の間は選択枠もマスクのプレビューも隠す(どちらも画面に実在する要素なので、
    // 隠さないと写り込む。マスクは offscreen 側で画素に焼き込むため、プレビューは不要)。
    function setOverlaysHidden(hidden) {
      const v = hidden ? "hidden" : "";
      if (outlineEl) outlineEl.style.visibility = v;
      if (maskLayerEl) maskLayerEl.style.visibility = v;
    }

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "画像保存";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      exitMaskMode();
      // 録画と同様、選択枠(outlineEl)自体が撮影範囲の境界に重なって描画されている
      // ため、キャプチャ中は非表示にしないと枠線がそのまま画像に写り込む。
      // ツールバー自身も position: fixed でビューポートに張り付いているため、
      // ビューポートを超える範囲をスクロールしながらタイル撮影する場合は、タイルごとに
      // 同じ位置のツールバーが写り込んで結合後の画像に何本も残る。単発撮影でも
      // 画面端でツールバーが選択範囲に重なって置かれることがあるので、保存中は
      // ツールバーごと非表示にする(finally で必ず戻す)。
      setOverlaysHidden(true);
      bar.style.visibility = "hidden";
      // 前回のダウンロード完了トーストが残っていると、それも写り込みうるので隠す
      setToastCaptureHidden(true);
      try {
        await nextPaint();
        await onSave();
      } catch (err) {
        console.error(LOG_PREFIX, "save failed", err);
      } finally {
        setToastCaptureHidden(false);
        setOverlaysHidden(false);
        bar.style.visibility = "";
        saveBtn.disabled = false;
      }
    });
    toolbarEl.appendChild(saveBtn);

    // マスク(黒塗り・モザイク)。ボタンを押すとドラッグで矩形を描くモードに入り、
    // もう一度押すかEscで抜ける。取消は直前に追加したマスクを1つ消す。
    for (const [type, text] of [
      ["black", "黒塗り"],
      ["mosaic", "モザイク"],
    ]) {
      const maskBtn = document.createElement("button");
      maskBtn.type = "button";
      maskBtn.textContent = text;
      maskBtn.dataset.maskType = type;
      maskBtn.title = "ドラッグした範囲を隠す(保存する画像・GIFに反映)。もう一度押すかEscで終了";
      maskBtn.addEventListener("click", () => {
        if (maskDrawing?.type === type) exitMaskMode();
        else enterMaskMode(type);
      });
      toolbarEl.appendChild(maskBtn);
    }
    const maskUndoBtn = document.createElement("button");
    maskUndoBtn.type = "button";
    maskUndoBtn.textContent = "取消";
    maskUndoBtn.dataset.maskUndo = "";
    maskUndoBtn.title = "直前に追加したマスクを取り消す";
    maskUndoBtn.disabled = true;
    maskUndoBtn.addEventListener("click", undoLastMask);
    toolbarEl.appendChild(maskUndoBtn);

    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.textContent = "録画開始";
    toolbarEl.appendChild(recordBtn);

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

    // フレームサンプリングの目標fps(1〜60、デフォルト30)。値を変えながら
    // 「なめらかさ」と「ファイルサイズ」の感触を手元で確かめられるようにするための
    // 入力欄(popup側にも同じものがある)。軽量化チェックボックスと同様、録画中は
    // 前提が変わるのを防ぐため disabled にする。
    const fpsLabel = document.createElement("label");
    fpsLabel.className = "gyazo-ext-tycoon-toolbar-fps";
    const fpsInput = document.createElement("input");
    fpsInput.type = "number";
    fpsInput.min = "1";
    fpsInput.max = "60";
    fpsInput.step = "1";
    fpsInput.value = "30";
    fpsInput.addEventListener("input", () => {
      fpsInput.value = fpsInput.value.replace(/[^0-9]/g, "");
    });
    fpsInput.addEventListener("change", () => {
      fpsInput.value = String(clampFps(fpsInput.value));
    });
    fpsLabel.appendChild(fpsInput);
    fpsLabel.appendChild(document.createTextNode("fps"));
    toolbarEl.appendChild(fpsLabel);

    // フレーム差分エンコード(gif-worker.js参照)のしきい値(0〜255、デフォルト24)。
    // 大きくするほどファイルサイズは下がるが、変化を取りこぼして残像(ゴースト)が
    // 出やすくなるトレードオフがあるため、実際の見え方を確認しながら調整できるように
    // する。0にすると常に全ピクセル再描画され(差分化を実質無効化)、残像は出ないが
    // ファイルサイズは差分化前と同程度に戻る。
    const diffThresholdLabel = document.createElement("label");
    diffThresholdLabel.className = "gyazo-ext-tycoon-toolbar-fps";
    diffThresholdLabel.title =
      "前フレームとの差分(0〜255)がこの値以下のピクセルは「変化なし」として再描画しない(サイズは下がるが、大きくしすぎると残像が出やすくなる)。0で常に全ピクセル再描画(残像なし・サイズは大きめ)。";
    const diffThresholdInput = document.createElement("input");
    diffThresholdInput.type = "number";
    diffThresholdInput.min = "0";
    diffThresholdInput.max = "255";
    diffThresholdInput.step = "1";
    diffThresholdInput.value = "24";
    diffThresholdInput.addEventListener("input", () => {
      diffThresholdInput.value = diffThresholdInput.value.replace(/[^0-9]/g, "");
    });
    diffThresholdInput.addEventListener("change", () => {
      diffThresholdInput.value = String(clampDiffThreshold(diffThresholdInput.value));
    });
    diffThresholdLabel.appendChild(diffThresholdInput);
    diffThresholdLabel.appendChild(document.createTextNode("差分"));
    toolbarEl.appendChild(diffThresholdLabel);

    // エンコード解像度(長辺の上限px)。自由入力ではなく大/中/小のプリセットから
    // 選ぶだけにしている(値の意味は offscreen/offscreen.js の GIF_SIZE_PRESETS 参照。
    // popup側にも同じものがある)。
    const sizeLabel = document.createElement("label");
    sizeLabel.className = "gyazo-ext-tycoon-toolbar-fps";
    const sizeSelect = document.createElement("select");
    for (const [value, text] of [
      ["large", "大(960px)"],
      ["medium", "中(640px)"],
      ["small", "小(400px)"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      sizeSelect.appendChild(option);
    }
    sizeSelect.value = "large";
    sizeLabel.appendChild(sizeSelect);
    toolbarEl.appendChild(sizeLabel);

    // 表示直後に、前回録画開始時の値を復元する(非同期のため一瞬デフォルト値が
    // 見えるが、ユーザーが操作するまでのごく短い時間なので許容する)。
    loadSavedGifSettings().then((settings) => {
      fpsInput.value = String(settings.fps);
      diffThresholdInput.value = String(settings.diffThreshold);
      sizeSelect.value = settings.size;
    });

    // 録画開始からの「nフレーム / x秒」表示。画像保存(1回きりの単発処理)には
    // 付けない(録画のように継続する状態ではないため表示する意味が薄い)。
    // 録画していない間も「0フレーム / 0.0秒」を表示しておき、録画開始/終了の
    // たびに表示の有無が切り替わってツールバーの大きさが変わらないようにする。
    const counterEl = document.createElement("span");
    counterEl.className = "gyazo-ext-tycoon-toolbar-counter";
    counterEl.textContent = "0フレーム / 0.0秒";
    toolbarEl.appendChild(counterEl);

    function formatCounter(state) {
      const seconds = (state?.elapsedMs ?? 0) / 1000;
      return `${state?.frameCount ?? 0}フレーム / ${seconds.toFixed(1)}秒`;
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
      recordingActive = isRecording;
      syncMaskButtons();
      recordBtn.textContent = isRecording ? "録画停止" : "録画開始";
      lightweightCheckbox.disabled = isRecording;
      fpsInput.disabled = isRecording;
      diffThresholdInput.disabled = isRecording;
      sizeSelect.disabled = isRecording;
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
            setOverlaysHidden(false);
          } else {
            exitMaskMode();
            setOverlaysHidden(true);
            dismissToast(); // 録画に写り込まないよう、残っているトーストは消す
            await nextPaint();
            const gifSettings = {
              fps: clampFps(fpsInput.value),
              diffThreshold: clampDiffThreshold(diffThresholdInput.value),
              size: sizeSelect.value,
            };
            saveGifSettings(gifSettings);
            const result = await onStartRecording({
              lightweight: lightweightCheckbox.checked,
              ...gifSettings,
            });
            if (!result?.ok) setOverlaysHidden(false); // 開始失敗時は表示を戻す
          }
        } catch (err) {
          console.error(LOG_PREFIX, "toggle recording failed", err);
          setOverlaysHidden(false);
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
          masks: masksForViewport(),
        });
        log("CROP_SELECTION_READY response", res);
      },
      canRecord: true,
      onStartRecording: ({ lightweight, fps, diffThreshold, size } = {}) =>
        chrome.runtime.sendMessage({
          type: "RECT_READY_FOR_RECORDING",
          rect,
          masks: masksForViewport(),
          viewportWidth,
          viewportHeight,
          dpr: window.devicePixelRatio || 1,
          lightweight,
          fps,
          diffThreshold,
          size,
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
            masks: masksForViewport(),
          });
          log("CROP_SELECTION_READY response", res);
          return;
        }
        // ビューポートより大きい/画面外にはみ出す要素は、フルページと同じ
        // タイル分割撮影で対応する(ページ絶対座標に変換して範囲指定)。
        await runTileCapture({
          pageLeft,
          pageTop,
          width: rect.width,
          height: rect.height,
          masks: masksForPage(),
        });
      },
      canRecord: fitsInViewport,
      // GIF録画はライブ映像を毎フレーム切り出す都合上、フルページ撮影のような
      // スクロールしながらのタイル分割には対応できない(録画中にスクロール位置を
      // 動かすと録画内容自体が乱れる)。ビューポートに収まる要素のみ録画可能にする。
      recordDisabledReason: "選択した要素は画面からはみ出しているため録画できません(画像保存は可能です)",
      onStartRecording: ({ lightweight, fps, diffThreshold, size } = {}) =>
        chrome.runtime.sendMessage({
          type: "RECT_READY_FOR_RECORDING",
          rect: rectPayload,
          masks: masksForViewport(),
          viewportWidth: captureViewportWidth,
          viewportHeight,
          dpr: window.devicePixelRatio || 1,
          lightweight,
          fps,
          diffThreshold,
          size,
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

  // ページ内の <video> の「今表示されているフレーム」をcanvasに直接drawImageして
  // PNG化する(chrome.tabs.captureVisibleTab によるスクリーン撮影は使わない)。
  // 動画自体の実解像度(videoWidth/videoHeight)でそのまま撮れるため、画面表示サイズや
  // 拡大率に左右されず、一時停止中の動画でも撮影できる。
  // 複数 <video> がある場合は、実際に読み込まれている(サイズが確定している)ものの
  // うち再生中のものを優先し、無ければ最初に見つかったものを使う。
  function pickVideoElement() {
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (v) => v.videoWidth > 0 && v.videoHeight > 0
    );
    if (videos.length === 0) return null;
    return videos.find((v) => !v.paused && !v.ended) ?? videos[0];
  }

  function captureVideoFrame() {
    const video = pickVideoElement();
    if (!video) {
      return { ok: false, error: "動画が見つかりません(再生できる状態の<video>がありません)" };
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      return { ok: true, dataUrl, width: canvas.width, height: canvas.height };
    } catch (err) {
      // クロスオリジンの動画(CORS未対応)を drawImage すると canvas が
      // "tainted" になり、toDataURL が SecurityError を投げる。
      log("captureVideoFrame failed (likely tainted canvas)", err);
      return {
        ok: false,
        error: "動画フレームの取得に失敗しました(クロスオリジンの動画など、取得がブロックされている可能性があります)",
      };
    }
  }

  // style 変更が実際に画面へ描画されるまで待つ(rAF は次の描画の直前に呼ばれるため2回待つ)。
  // visibility を切り替えた直後に captureVisibleTab を呼ぶと、再描画前の画面が撮影されて
  // 選択枠が写り込むことがある。
  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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

  // sticky 要素が「今まさに貼り付いている(=スクロールしても画面上の位置が動かない)」か。
  // 貼り付いていない sticky はページの流れの中の通常位置にあるだけなので隠す必要がない。
  function isStickyStuck(cs, rect, viewportHeight) {
    const top = parseFloat(cs.top);
    const bottom = parseFloat(cs.bottom);
    if (!Number.isNaN(top) && rect.top <= top + 0.5) return true;
    if (!Number.isNaN(bottom) && viewportHeight - rect.bottom <= bottom + 0.5) return true;
    return false;
  }

  // position: fixed / 貼り付き中の sticky 要素(追従ヘッダー・フッターバー・チャット
  // ウィジェット・Cookieバナーなど)を visibility: hidden にして、戻すための関数を返す。
  // タイル撮影ではこれらが毎タイル同じ画面位置に写り込んで本文を隠してしまう
  // (スクロール後に突然出現するフッターバーなども含む)。visibility なので
  // レイアウトは動かず、隠した下の本文がそのまま写るため、結合しても継ぎ目がずれない。
  // keepTopAnchored が true のときは、ビューポート上半分にある要素(上端の追従ヘッダー
  // など)は残す。ページ最上部のタイルでだけ使い、ヘッダーを結合画像の先頭に1回だけ
  // 写すため。
  function hideFloatingElements({ keepTopAnchored }) {
    const viewportHeight = document.documentElement.clientHeight;
    const hidden = [];
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const position = cs.position;
      if (position !== "fixed" && position !== "sticky") continue;
      if (cs.display === "none") continue;
      if (el.closest('[class*="gyazo-ext-tycoon"]')) continue; // この拡張自身のUI
      const rect = el.getBoundingClientRect();
      if (position === "sticky" && !isStickyStuck(cs, rect, viewportHeight)) continue;
      if (keepTopAnchored && rect.top < viewportHeight / 2) continue;
      hidden.push({
        el,
        value: el.style.getPropertyValue("visibility"),
        priority: el.style.getPropertyPriority("visibility"),
      });
      el.style.setProperty("visibility", "hidden", "important");
    }
    log("hid floating elements", { count: hidden.length, keepTopAnchored });
    return () => {
      for (const { el, value, priority } of hidden) {
        if (value) el.style.setProperty("visibility", value, priority);
        else el.style.removeProperty("visibility");
      }
    };
  }

  // pageLeft/pageTop/width/height はページ絶対座標(CSS px)。
  // スクロールしながら captureVisibleTab を繰り返し、タイル一覧を
  // background(→offscreen)に送って結合・保存してもらう。
  // masks は保存時にページ絶対座標へ変換済みのもの(省略可)。
  async function runTileCapture({ pageLeft, pageTop, width, height, masks: tileMasks }) {
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
    let restoreFloating = null;

    // トースト(拡張機能自身のUI)は hideFloatingElements の対象外なので、
    // タイル撮影の間は自分で隠しておく(毎タイル同じ位置に写り込むため)。
    setToastCaptureHidden(true);
    try {
      for (let i = 0; i < MAX_TILES && currentY < endY; i++) {
        window.scrollTo(pageLeft, currentY);
        await waitFor(SCROLL_SETTLE_MS);
        const actualScrollY = window.scrollY;

        if (actualScrollY === lastScrollY) break; // これ以上スクロールできない(下端に到達)
        lastScrollY = actualScrollY;

        // 追従要素はスクロール位置ごとに出たり消えたり(スクロール後に突然出現する
        // フッターなど)するため、タイルごとに戻して探し直す。
        restoreFloating?.();
        restoreFloating = hideFloatingElements({
          keepTopAnchored: i === 0 && actualScrollY === 0,
        });
        await nextPaint();

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
    } finally {
      restoreFloating?.();
      window.scrollTo(originalScrollX, originalScrollY);
      setToastCaptureHidden(false);
    }

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
        masks: tileMasks,
      });
      log("TILES_READY response", res);
    } catch (err) {
      console.error(LOG_PREFIX, "TILES_READY failed", err);
    }
  }

  // --- ダウンロード結果のトースト ---
  // 撮影・保存が終わったら、ページの隅に「ダウンロードしました [フォルダを表示] [画像をコピー]」
  // を目立たない形で出す(background の reportToast から SHOW_TOAST で呼ばれる)。
  // - ページ側のCSSに影響されず、overlay.css の注入有無にも依存しないよう、Shadow DOM の中に
  //   スタイルごと自己完結させている。
  // - 既定は右上。矩形選択・要素選択の選択枠やツールバーと重なる場合は、重ならない隅へ逃げる
  //   (選択枠の外側に出して、連続撮影の邪魔にも画像への写り込みにもならないようにするため)。
  const TOAST_AUTO_HIDE_MS = 8000;
  const TOAST_ERROR_HIDE_MS = 10000;
  const TOAST_AFTER_LEAVE_MS = 3000; // マウスが離れてから消えるまで
  const TOAST_MARGIN = 12; // 画面端との余白
  const TOAST_AVOID_PADDING = 8; // 選択枠・ツールバーとの最低限の間隔
  const TOAST_CORNERS = ["top-right", "top-left", "bottom-right", "bottom-left"];
  const TOAST_WATCH_INTERVAL_MS = 200; // 選択枠の変化に追従して位置を見直す間隔

  const TOAST_STYLE = `
    .toast {
      position: absolute;
      left: 0;
      top: 0;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      width: max-content;
      max-width: min(460px, calc(100vw - 24px));
      padding: 8px 8px 8px 12px;
      border-radius: 8px;
      border-left: 4px solid #27ae60;
      background: rgba(32, 33, 36, 0.96);
      color: #fff;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      opacity: 0;
      pointer-events: auto;
    }
    .toast.show { opacity: 1; }
    /* 最初の配置が済んでから有効にする(左上から滑ってくる動きを防ぐ) */
    .toast.ready { transition: left 180ms ease, top 180ms ease, opacity 150ms ease; }
    .toast.error { border-left-color: #eb5757; }
    .text { min-width: 0; }
    .title { font-weight: 600; white-space: nowrap; }
    .detail {
      margin-top: 1px;
      color: #c4c7c5;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions { display: flex; gap: 6px; flex-shrink: 0; }
    button {
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 4px;
      background: transparent;
      color: #fff;
      font: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.15); }
    button:disabled { opacity: 0.6; cursor: default; }
    .close { border: none; padding: 2px 6px; font-size: 14px; line-height: 1; }
  `;

  let toastHostEl = null;
  let toastEl = null;
  let toastCorner = null;
  let toastHideTimer = null;
  let toastWatchTimer = null;
  // 撮影中だけトーストを隠すための入れ子カウンター(保存ボタン → タイル撮影のように重なる)
  let toastCaptureHideDepth = 0;

  function dismissToast() {
    clearTimeout(toastHideTimer);
    clearInterval(toastWatchTimer);
    toastHideTimer = null;
    toastWatchTimer = null;
    toastHostEl?.remove();
    toastHostEl = null;
    toastEl = null;
    toastCorner = null;
  }

  // 撮影(画面キャプチャ)の間だけトーストを非表示にする。写り込み防止用。
  function setToastCaptureHidden(hidden) {
    toastCaptureHideDepth = Math.max(0, toastCaptureHideDepth + (hidden ? 1 : -1));
    if (toastHostEl) toastHostEl.style.visibility = toastCaptureHideDepth > 0 ? "hidden" : "";
  }

  function scheduleToastHide(ms) {
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(dismissToast, ms);
  }

  // トーストが避けるべき領域(いま画面にある選択枠・ツールバー)。
  function getToastAvoidRects() {
    const rects = [];
    for (const el of [selectionBoxEl, highlightEl, toolbarEl]) {
      if (!el || !el.isConnected) continue;
      if (getComputedStyle(el).display === "none") continue; // ドラッグ開始前の選択枠など
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      rects.push({
        left: r.left - TOAST_AVOID_PADDING,
        top: r.top - TOAST_AVOID_PADDING,
        right: r.right + TOAST_AVOID_PADDING,
        bottom: r.bottom + TOAST_AVOID_PADDING,
      });
    }
    return rects;
  }

  function overlapArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // 置く隅を決める。いまの隅が空いていればそのまま(ふらつき防止)、重なっていれば
  // 重ならない最初の隅へ。どこも重なる(選択範囲が画面いっぱい等)なら重なりが最小の隅。
  function pickToastCorner(positions, avoid) {
    const overlapOf = (corner) => {
      const p = positions[corner];
      const box = { left: p.left, top: p.top, right: p.right, bottom: p.bottom };
      return avoid.reduce((sum, r) => sum + overlapArea(box, r), 0);
    };
    if (toastCorner && overlapOf(toastCorner) === 0) return toastCorner;
    let best = TOAST_CORNERS[0];
    let bestOverlap = Infinity;
    for (const corner of TOAST_CORNERS) {
      const o = overlapOf(corner);
      if (o === 0) return corner;
      if (o < bestOverlap) {
        best = corner;
        bestOverlap = o;
      }
    }
    return best;
  }

  function updateToastPosition() {
    if (!toastEl) return;
    const w = toastEl.offsetWidth;
    const h = toastEl.offsetHeight;
    const vw = document.documentElement.clientWidth; // スクロールバー分を除く
    const vh = document.documentElement.clientHeight;
    const m = TOAST_MARGIN;
    const left = { r: Math.max(0, vw - w - m), l: m };
    const top = { t: m, b: Math.max(0, vh - h - m) };
    const origin = {
      "top-right": { left: left.r, top: top.t },
      "top-left": { left: left.l, top: top.t },
      "bottom-right": { left: left.r, top: top.b },
      "bottom-left": { left: left.l, top: top.b },
    };
    const positions = {};
    for (const [corner, p] of Object.entries(origin)) {
      positions[corner] = { ...p, right: p.left + w, bottom: p.top + h };
    }
    toastCorner = pickToastCorner(positions, getToastAvoidRects());
    // 隅が同じでもウィンドウサイズが変わっていれば座標は変わるので、毎回反映する
    toastEl.style.left = `${positions[toastCorner].left}px`;
    toastEl.style.top = `${positions[toastCorner].top}px`;
  }

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("画像データが不正です");
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  // image: { dataUrl } ならそのまま、{ blobUrl } なら background に取りに行ってもらう
  // (offscreen document が作った Blob URL は、ページ側からは直接読めないため)。
  async function loadImageBlob(image) {
    let dataUrl = image.dataUrl;
    if (!dataUrl) {
      const res = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE_DATA_URL", url: image.blobUrl });
      if (!res?.ok) throw new Error(res?.error ?? "画像の取得に失敗しました");
      dataUrl = res.dataUrl;
    }
    return dataUrlToBlob(dataUrl);
  }

  // opts: { ok, title, detail?, downloadId?, image? }
  function showToast({ ok, title, detail, downloadId, image }) {
    dismissToast();

    toastHostEl = document.createElement("div");
    toastHostEl.className = "gyazo-ext-tycoon-toast-host";
    // 大きさ0の固定要素にして、トースト本体を中で絶対配置する(ページのレイアウトに干渉しない)。
    toastHostEl.style.cssText =
      "all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;";
    if (toastCaptureHideDepth > 0) toastHostEl.style.visibility = "hidden";
    const shadow = toastHostEl.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = TOAST_STYLE;
    shadow.appendChild(style);

    toastEl = document.createElement("div");
    toastEl.className = ok ? "toast" : "toast error";
    toastEl.setAttribute("role", "status");
    const el = toastEl;

    const text = document.createElement("div");
    text.className = "text";
    const titleEl = document.createElement("div");
    titleEl.className = "title";
    titleEl.textContent = `${ok ? "✓" : "⚠"} ${title}`;
    text.appendChild(titleEl);
    if (detail) {
      const detailEl = document.createElement("div");
      detailEl.className = "detail";
      detailEl.textContent = detail;
      detailEl.title = detail;
      text.appendChild(detailEl);
    }
    el.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "actions";
    if (ok && typeof downloadId === "number") {
      const showBtn = document.createElement("button");
      showBtn.type = "button";
      showBtn.textContent = "フォルダを表示";
      showBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "SHOW_DOWNLOAD", downloadId }).catch((err) => {
          console.error(LOG_PREFIX, "SHOW_DOWNLOAD failed", err);
        });
        scheduleToastHide(TOAST_AFTER_LEAVE_MS);
      });
      actions.appendChild(showBtn);
    }
    if (ok && image) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "画像をコピー";
      copyBtn.addEventListener("click", async () => {
        copyBtn.disabled = true;
        copyBtn.textContent = "コピー中…";
        try {
          // クリックのユーザー操作が有効なうちに clipboard.write を呼ぶ必要があるため、
          // 画像の取得を待たずに Promise のまま ClipboardItem へ渡す。
          // 画像そのもの(image/png)を書き込むので、Claude などにそのまま貼り付けられる。
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": loadImageBlob(image) }),
          ]);
          copyBtn.textContent = "コピーしました ✓";
        } catch (err) {
          console.error(LOG_PREFIX, "copy image failed", err);
          copyBtn.textContent = "コピー失敗";
          copyBtn.title = String(err?.message || err);
        } finally {
          copyBtn.disabled = false;
          scheduleToastHide(TOAST_AFTER_LEAVE_MS + 2000);
        }
      });
      actions.appendChild(copyBtn);
    }
    if (actions.childElementCount > 0) el.appendChild(actions);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "閉じる");
    closeBtn.addEventListener("click", dismissToast);
    el.appendChild(closeBtn);

    // 操作中は消えないようにする(ボタンを押す前に消えるのを防ぐ)
    el.addEventListener("mouseenter", () => clearTimeout(toastHideTimer));
    el.addEventListener("mouseleave", () => scheduleToastHide(TOAST_AFTER_LEAVE_MS));

    shadow.appendChild(el);
    document.documentElement.appendChild(toastHostEl);

    updateToastPosition();
    requestAnimationFrame(() => {
      if (toastEl === el) el.classList.add("ready", "show");
    });
    // 選択枠の確定・ドラッグ・ツールバーの出現/移動に合わせて、必要なら隅を移し替える
    toastWatchTimer = setInterval(updateToastPosition, TOAST_WATCH_INTERVAL_MS);
    scheduleToastHide(ok ? TOAST_AUTO_HIDE_MS : TOAST_ERROR_HIDE_MS);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "SHOW_TOAST":
        showToast(message);
        sendResponse({ ok: true });
        break;
      case "PREPARE_CAPTURE":
        // 画面を撮る直前に、残っているトーストを消して描画反映を待つ
        // (非表示のタブでは rAF が止まるため、待ちすぎないようタイムアウトを付ける)
        dismissToast();
        Promise.race([nextPaint(), waitFor(300)]).then(() => sendResponse({ ok: true }));
        return true;
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
      case "CAPTURE_VIDEO_FRAME":
        sendResponse(captureVideoFrame());
        break;
      default:
        break;
    }
  });

  window.__gyazoExtTycoonReinit = () => {
    cleanupOverlay();
  };
})();
