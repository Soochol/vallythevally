const query = new URLSearchParams(location.search);
const kind = query.get("kind");
const path = query.get("path");
const perSecond = Number(query.get("perSecond"));
const seconds = Number(query.get("seconds"));
const websocketPort = query.get("websocket");
const HISTORY_BARS = 300;
const MINUTE = 60;
const statusLine = document.getElementById("status");

function nowMillis() {
  return performance.timeOrigin + performance.now();
}

const CLOCK_SAMPLES = 100;
const CLOCK_BEST = 20;

async function clockOffset() {
  const samples = [];
  for (let index = 0; index < CLOCK_SAMPLES; index += 1) {
    const before = nowMillis();
    const server = Number(await (await fetch("/now", { cache: "no-store" })).text());
    const after = nowMillis();
    samples.push({ roundTrip: after - before, offset: server - (before + after) / 2 });
  }
  const best = samples.sort((a, b) => a.roundTrip - b.roundTrip).slice(0, CLOCK_BEST).map((sample) => sample.offset).sort((a, b) => a - b);
  return best[Math.floor(best.length / 2)];
}

async function post(endpoint, body) {
  await fetch(endpoint, { method: "POST", body: body === undefined ? "" : JSON.stringify(body) });
}

function renderer() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  } catch {
    return null;
  }
}

function receiver(onTrade, onEnd) {
  return (message) => {
    const received = nowMillis();
    if (message.type === "end") onEnd(message.sent);
    else onTrade(message, received);
  };
}

function connect(handle) {
  if (path === "ipc") {
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = handle;
    return { start: () => window.__TAURI__.core.invoke("bench_stream", { perSecond, seconds, events: channel }) };
  }
  const socket = new WebSocket(`ws://127.0.0.1:${websocketPort}/`);
  socket.onmessage = (event) => handle(JSON.parse(event.data));
  socket.onerror = () => fail("WebSocket 오류");
  return { start: () => socket.send(JSON.stringify({ perSecond, seconds })), ready: new Promise((resolve) => (socket.onopen = resolve)) };
}

function history(lastMinute) {
  const bars = [];
  let close = 70000;
  for (let index = HISTORY_BARS; index > 0; index -= 1) {
    const open = close;
    close = open + ((index * 37) % 11) * 10 - 50;
    bars.push({ time: lastMinute - index * MINUTE, open, high: Math.max(open, close) + 20, low: Math.min(open, close) - 20, close });
  }
  return bars;
}

function createLiveChart(firstMinute) {
  const chart = LightweightCharts.createChart(document.getElementById("chart"), { width: 1200, height: 600, layout: { background: { color: "#111" }, textColor: "#ddd" }, localization: { locale: "en-US" } });
  const series = chart.addSeries(LightweightCharts.CandlestickSeries);
  series.setData(history(firstMinute));
  return series;
}

function barUpdater(series) {
  let bar = null;
  return (trade) => {
    const time = Math.floor(trade.t / MINUTE) * MINUTE;
    if (bar === null || bar.time !== time) bar = { time, open: trade.price, high: trade.price, low: trade.price, close: trade.price };
    else bar = { time, open: bar.open, high: Math.max(bar.high, trade.price), low: Math.min(bar.low, trade.price), close: trade.price };
    series.update(bar);
  };
}

function frameRecorder() {
  const intervals = [];
  let last = null;
  let running = true;
  let startedAt = null;
  const tick = (timestamp) => {
    if (!running) return;
    if (last !== null) intervals.push(timestamp - last);
    else startedAt = timestamp;
    last = timestamp;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop: () => { running = false; return frameReport(intervals, last === null ? 0 : last - startedAt); } };
}

function fail(reason) {
  statusLine.textContent = `실패: ${reason}`;
  post("/result", { error: String(reason) });
}

function environment() {
  return { userAgent: navigator.userAgent, renderer: renderer(), devicePixelRatio: window.devicePixelRatio };
}

async function measure() {
  const offset = await clockOffset();
  const latencies = new Float64Array(perSecond * seconds);
  let received = 0;
  const chart = kind === "chart";
  let draw = null;
  let frames = null;
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  const link = connect(receiver((message, receivedAt) => {
    if (received < latencies.length) latencies[received] = receivedAt + offset - message.sentAt;
    received += 1;
    if (draw) draw(message.trades[0]);
  }, (sent) => finished(sent)));
  if (link.ready) await link.ready;
  if (chart) draw = barUpdater(createLiveChart(Math.floor(Date.now() / 1000 / MINUTE) * MINUTE));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  statusLine.textContent = `측정 중: ${kind} ${path ?? "websocket"} 초당 ${perSecond}건 ${seconds}초`;
  await post("/begin");
  if (chart) frames = frameRecorder();
  await link.start();
  const sent = await done;
  await post("/end");
  const frameStats = frames ? frames.stop() : null;
  const result = { kind, path: chart ? "websocket" : path, perSecond, seconds, sent, received, latencyMs: summarize(latencies.subarray(0, Math.min(received, latencies.length))), clockOffsetMs: offset, frames: frameStats, environment: environment() };
  statusLine.textContent = `끝: 보낸 ${sent}건, 받은 ${received}건`;
  await post("/result", result);
}

window.addEventListener("error", (event) => fail(event.message));
window.addEventListener("unhandledrejection", (event) => fail(event.reason));
measure().catch(fail);
