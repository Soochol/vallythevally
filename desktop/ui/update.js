const POLL_MILLIS = 500;
const invoke = window.__TAURI__.core.invoke;
const headline = document.getElementById("headline");
const detail = document.getElementById("detail");
const notes = document.getElementById("notes");
const progress = document.getElementById("progress");
const primary = document.getElementById("primary");
const secondary = document.getElementById("secondary");

function megabytes(bytes) {
  return (bytes / 1048576).toFixed(1);
}

function showButton(button, label, action) {
  button.hidden = !label;
  button.textContent = label || "";
  button.onclick = label ? action : null;
}

function render(status) {
  document.body.classList.toggle("failed", status.state === "install_failed");
  notes.hidden = true;
  progress.hidden = true;
  showButton(primary, null);
  showButton(secondary, null);
  if (status.state === "available") {
    headline.textContent = `새 판 ${status.version}이 나왔습니다`;
    detail.textContent = "지금 설치하면 앱이 잠시 닫혔다가 다시 열립니다. 주문 중이면 나중에 설치하세요.";
    notes.hidden = !status.notes;
    notes.textContent = status.notes || "";
    showButton(primary, "지금 설치하고 다시 시작", () => invoke("install_update").catch(() => {}));
    showButton(secondary, "나중에", () => invoke("dismiss_update_notice"));
  } else if (status.state === "downloading") {
    headline.textContent = "새 판을 받는 중";
    progress.hidden = false;
    progress.max = status.total || 0;
    progress.value = status.received;
    detail.textContent = status.total ? `${megabytes(status.received)} / ${megabytes(status.total)} MB` : `${megabytes(status.received)} MB`;
  } else if (status.state === "installing") {
    headline.textContent = "새 판을 설치하는 중";
    detail.textContent = "설치가 끝나면 앱이 다시 열립니다.";
  } else if (status.state === "install_failed") {
    headline.textContent = "새 판을 설치하지 못했습니다";
    detail.textContent = status.reason;
    if (status.engine_stopped) {
      showButton(primary, "앱 다시 시작", () => invoke("restart_app"));
    } else {
      showButton(primary, "다시 시도", () => invoke("install_update").catch(() => {}));
      showButton(secondary, "닫기", () => invoke("dismiss_update_notice"));
    }
  } else if (status.state === "check_failed") {
    headline.textContent = "업데이트를 확인하지 못했습니다";
    detail.textContent = status.reason;
    showButton(secondary, "닫기", () => invoke("dismiss_update_notice"));
  } else if (status.state === "current") {
    headline.textContent = "업데이트가 없습니다";
    detail.textContent = "";
    showButton(secondary, "닫기", () => invoke("dismiss_update_notice"));
  }
}

async function poll() {
  render(await invoke("update_status"));
  setTimeout(poll, POLL_MILLIS);
}

poll().catch((error) => {
  headline.textContent = "업데이트 상태를 읽지 못했습니다";
  detail.textContent = String(error);
});
