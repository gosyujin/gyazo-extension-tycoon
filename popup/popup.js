const messageEl = document.getElementById("message");
const recordBtn = document.getElementById("btn-record");
const recordStatusEl = document.getElementById("record-status");

function showMessage(text) {
  messageEl.textContent = text;
}

async function send(type) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
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
  if (state?.isRecording) {
    recordBtn.textContent = "録画停止してGIF保存";
    recordBtn.classList.add("recording");
    recordStatusEl.textContent = "録画中...";
  } else {
    recordBtn.textContent = "録画開始";
    recordBtn.classList.remove("recording");
    recordStatusEl.textContent = "";
  }
}

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  const response = await send("TOGGLE_RECORDING");
  recordBtn.disabled = false;
  if (response?.recordingState) {
    renderRecordingState(response.recordingState);
  }
  if (response?.recordingState && !response.recordingState.isRecording) {
    // 停止 = GIF保存完了。popupを閉じてよい。
    window.close();
  }
});

(async () => {
  const state = await send("GET_RECORDING_STATE");
  renderRecordingState(state);
})();
