const POLL_MILLIS = 250;
const headline = document.getElementById("headline");
const detail = document.getElementById("detail");
const log = document.getElementById("log");

function showFailure(status) {
  document.body.classList.add("failed");
  headline.textContent = "엔진을 시작하지 못했습니다";
  detail.textContent = status.reason;
  log.textContent = status.log.join("\n");
  log.hidden = status.log.length === 0;
}

async function poll() {
  const status = await window.__TAURI__.core.invoke("engine_status");
  if (status.state === "ready") {
    window.location.replace(status.url);
    return;
  }
  if (status.state === "failed") {
    showFailure(status);
    return;
  }
  setTimeout(poll, POLL_MILLIS);
}

poll().catch((error) => showFailure({ reason: String(error), log: [] }));
