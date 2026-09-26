const messageEl = document.getElementById("message");
const recordStatusEl = document.getElementById("record-status");
const btnRecordRect = document.getElementById("btn-record-rect");
const btnRecordElement = document.getElementById("btn-record-element");
const btnRecordVisible = document.getElementById("btn-record-visible");
const btnRecordStop = document.getElementById("btn-record-stop");

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

function renderRecordingState(state) {
  const isRecording = !!state?.isRecording;
  btnRecordRect.disabled = isRecording;
  btnRecordElement.disabled = isRecording;
  btnRecordVisible.disabled = isRecording;
  btnRecordStop.disabled = !isRecording;
  recordStatusEl.textContent = isRecording ? "録画中...(停止するとGIFが保存されます)" : "";
}

// 矩形選択・要素選択は、ページ側のオーバーレイで選択が終わったタイミングで
// 録画が始まる(選択中はこのpopupは閉じている必要があるため)。
btnRecordRect.addEventListener("click", async () => {
  await send("START_RECT_SELECT", { mode: "record" });
  window.close();
});

btnRecordElement.addEventListener("click", async () => {
  await send("START_ELEMENT_SELECT", { mode: "record" });
  window.close();
});

btnRecordVisible.addEventListener("click", async () => {
  btnRecordVisible.disabled = true;
  const response = await send("START_RECORDING_VISIBLE");
  if (response?.recordingState) renderRecordingState(response.recordingState);
});

btnRecordStop.addEventListener("click", async () => {
  btnRecordStop.disabled = true;
  const response = await send("STOP_RECORDING");
  if (response?.recordingState) renderRecordingState(response.recordingState);
  window.close();
});

(async () => {
  const state = await send("GET_RECORDING_STATE");
  renderRecordingState(state);
})();
