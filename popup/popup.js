const messageEl = document.getElementById("message");
const recordStatusEl = document.getElementById("record-status");
const recordCounterEl = document.getElementById("record-counter");
const btnRecordVisible = document.getElementById("btn-record-visible");
const btnRecordStop = document.getElementById("btn-record-stop");
const chkLightweight = document.getElementById("chk-lightweight");

function showMessage(text) {
  messageEl.textContent = text;
}

async function send(type, extra = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (response && response.ok === false) {
      showMessage(`エラー: ${response.error}`);
    }
    return response;
  } catch (err) {
    showMessage(`エラー: ${err.message}`);
  }
}

// 矩形選択・要素選択は「範囲を選ぶ」だけをここで開始する。選んだ範囲に対して
// 画像保存/録画するかどうかは、ページ側に表示されるツールバーで選ぶ
// (選択操作のためこのpopup自体は閉じる必要がある)。
document.getElementById("btn-rect").addEventListener("click", async () => {
  await send("START_RECT_SELECT");
  window.close();
});

document.getElementById("btn-element").addEventListener("click", async () => {
  await send("START_ELEMENT_SELECT");
  window.close();
});

document.getElementById("btn-visible").addEventListener("click", async () => {
  await send("CAPTURE_VISIBLE_PAGE");
  window.close();
});

document.getElementById("btn-fullpage").addEventListener("click", async () => {
  await send("START_FULLPAGE_CAPTURE");
  window.close();
});

// 録画中は「nフレーム / x秒」を表示する。実際のフレーム数・経過時間は
// offscreen document(録画の実体を持つ)が真実の情報源なので、録画中は
// GET_RECORDING_STATE を定期的にポーリングして表示を更新する。
function formatCounter(state) {
  if (!state?.isRecording) return "";
  const seconds = (state.elapsedMs ?? 0) / 1000;
  return `${state.frameCount ?? 0}フレーム / ${seconds.toFixed(1)}秒`;
}

let pollTimer = null;

function renderRecordingState(state) {
  const isRecording = !!state?.isRecording;
  btnRecordVisible.disabled = isRecording;
  btnRecordStop.disabled = !isRecording;
  // 「軽量化するかどうか」は録画開始時に確定させ、録画終了までは変更させない。
  chkLightweight.disabled = isRecording;
  recordStatusEl.textContent = isRecording ? "録画中...(停止するとGIFが保存されます)" : "";
  recordCounterEl.textContent = formatCounter(state);

  if (isRecording) {
    if (!pollTimer) {
      pollTimer = setInterval(async () => {
        renderRecordingState(await send("GET_RECORDING_STATE"));
      }, 500);
    }
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

btnRecordVisible.addEventListener("click", async () => {
  btnRecordVisible.disabled = true;
  const response = await send("START_RECORDING_VISIBLE", { lightweight: chkLightweight.checked });
  if (response?.recordingState) renderRecordingState(response.recordingState);
});

btnRecordStop.addEventListener("click", async () => {
  btnRecordStop.disabled = true;
  const response = await send("STOP_RECORDING");
  if (response?.recordingState) renderRecordingState(response.recordingState);
  window.close();
});

// キーボードショートカットの割り当てはChrome標準の画面(chrome://extensions/shortcuts)
// に任せる方針のため、独自の設定UIは作らずそこへのショートカットだけ用意する。
document.getElementById("btn-shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});

(async () => {
  const state = await send("GET_RECORDING_STATE");
  renderRecordingState(state);
})();
