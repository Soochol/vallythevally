import { openSpan } from "./decode.js";
import { STALE, latestOnly } from "./latest.js";
import { SPAN_MINUTES, entryIndexAt } from "./seek.js";
import { RECENT_TRADE_LIMIT, buildFrame, emptyFrame, formatClock, parseClock } from "./replay.js";
import { createView } from "./view.js";

const MAX_CACHED_SPANS = 24;
const PREFETCH_OFFSETS = [0, -1, 1, 2];
const MAX_GAP_FILES = 40;
const MAX_TRADE_LOOKBACK_SPANS = 12;
const FRAME_SAMPLES = 300;
const MAX_FRAME_STEP_MS = 250;
const STAT_REFRESH_FRAMES = 30;
const SPAN_MS = SPAN_MINUTES * 60_000;
const DASH = "—";

const byId = (id) => document.getElementById(id);
const el = {
  replay: byId("replay"),
  date: byId("date"),
  item: byId("item"),
  play: byId("play"),
  speed: byId("speed"),
  clock: byId("clock"),
  bar: byId("bar"),
  barGaps: byId("bar-gaps"),
  playhead: byId("bar-playhead"),
  status: byId("status"),
  frameStat: byId("frame-stat"),
};

class SpanLoader {
  constructor(limit) {
    this.limit = limit;
    this.worker = new Worker("/worker.js", { type: "module" });
    this.cache = new Map();
    this.pending = new Map();
    this.failed = new Map();
    this.protectedKeys = new Set();
    this.nextId = 1;
    this.onLoad = () => {};
    this.worker.onmessage = ({ data }) => this.receive(data);
  }

  request(key, url) {
    if (this.cache.has(key) || this.failed.has(key) || [...this.pending.values()].includes(key)) return;
    const id = this.nextId++;
    this.pending.set(id, key);
    this.worker.postMessage({ id, url });
  }

  receive({ id, layout, buffer, error }) {
    const key = this.pending.get(id);
    this.pending.delete(id);
    if (error) {
      this.failed.set(key, error);
    } else {
      const span = openSpan(layout, buffer);
      this.cache.set(key, span);
      this.evict();
      this.onLoad(key, span);
      return;
    }
    this.onLoad(key, null);
  }

  evict() {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.limit) break;
      if (!this.protectedKeys.has(key)) this.cache.delete(key);
    }
  }

  get(key) {
    const span = this.cache.get(key);
    if (span) {
      this.cache.delete(key);
      this.cache.set(key, span);
    }
    return span;
  }

  peek(key) {
    return this.cache.get(key);
  }
}

const loader = new SpanLoader(MAX_CACHED_SPANS);
const view = createView();
const gapIntervals = new Map();

const state = {
  dates: [],
  date: null,
  item: null,
  index: null,
  members: {},
  entries: [],
  starts: [],
  min: 0,
  max: 0,
  cursorExact: 0,
  cursor: 0,
  drawnCursor: null,
  windowEntry: -2,
  dirty: true,
  notice: "",
  playing: false,
  speed: 1,
};

const frameIntervals = new Float64Array(FRAME_SAMPLES);
let intervalCount = 0;
let intervalHead = 0;
let framesSinceStat = 0;

function setStatus(text) {
  if (el.status.textContent !== text) el.status.textContent = text;
}

function setReady(ready) {
  el.replay.dataset.ready = String(ready);
}

function keyOf(entry) {
  return `${state.date}/${state.item}/${state.entries[entry].file}`;
}

function urlOf(entry) {
  const file = state.entries[entry].file.replace(/\.br$/, "");
  return `/data/${state.date}/${state.item}/${file}`;
}

function minutesOfStart(text) {
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(2));
}

function keysAround(entry) {
  return PREFETCH_OFFSETS.map((offset) => entry + offset).filter((index) => index >= 0 && index < state.entries.length);
}

function ensureWindow(entry) {
  state.windowEntry = entry;
  const around = keysAround(entry);
  loader.protectedKeys = new Set(around.map(keyOf));
  for (const index of around) loader.request(keyOf(index), urlOf(index));
}

function requestGapFiles() {
  let requested = 0;
  state.entries.forEach((entry, index) => {
    if (entry.rows.gaps > 0 && requested < MAX_GAP_FILES) {
      requested += 1;
      loader.request(keyOf(index), urlOf(index));
    }
  });
}

function renderBarGaps() {
  const prefix = `${state.date}/${state.item}/`;
  const length = state.max - state.min + 1;
  const marks = [];
  for (const [key, intervals] of gapIntervals) {
    if (!key.startsWith(prefix)) continue;
    for (const { from, to } of intervals) {
      const mark = document.createElement("div");
      mark.className = "bar-gap";
      mark.style.left = `${((from - state.min) / length) * 100}%`;
      mark.style.width = `${((to - from) / length) * 100}%`;
      marks.push(mark);
    }
  }
  el.barGaps.replaceChildren(...marks);
}

loader.onLoad = (key, span) => {
  state.dirty = true;
  if (span?.streams.gaps && span.streams.gaps.rows > 0) {
    const { from_ms: from, to_ms: to } = span.streams.gaps.columns;
    gapIntervals.set(key, Array.from(from, (start, row) => ({ from: start, to: to[row] })));
    renderBarGaps();
  }
};

function clampCursor(ms) {
  return Math.min(Math.max(ms, state.min), state.max);
}

function setTarget(ms) {
  state.cursorExact = clampCursor(ms);
  state.cursor = Math.floor(state.cursorExact);
  state.dirty = true;
  setReady(false);
}

function syncUrl() {
  if (state.date === null || state.item === null) return;
  const parameters = new URLSearchParams({ date: state.date, item: state.item, t: formatClock(state.cursor) });
  history.replaceState(null, "", `?${parameters}`);
}

function setPlaying(playing) {
  state.playing = playing;
  el.play.textContent = playing ? "멈춤" : "재생";
  el.play.dataset.playing = String(playing);
  if (!playing) {
    if (state.cursor !== state.drawnCursor) setReady(false);
    updateFrameStat();
    syncUrl();
  }
  lastWasPlaying = false;
}

function pushInterval(milliseconds) {
  frameIntervals[intervalHead] = milliseconds;
  intervalHead = (intervalHead + 1) % FRAME_SAMPLES;
  intervalCount = Math.min(intervalCount + 1, FRAME_SAMPLES);
}

function updateFrameStat() {
  if (intervalCount === 0) {
    el.frameStat.textContent = `프레임 p95 ${DASH}`;
    return;
  }
  const sorted = Array.from(frameIntervals.subarray(0, intervalCount)).sort((left, right) => left - right);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  el.frameStat.textContent = `프레임 p95 ${p95.toFixed(1)}ms`;
  el.frameStat.dataset.p95 = p95.toFixed(1);
}

function advance(elapsedMs) {
  const next = Math.min(state.cursorExact + elapsedMs * state.speed, state.max);
  const entry = entryIndexAt(state.starts, Math.floor(next));
  if (entry >= 0) {
    const key = keyOf(entry);
    if (!loader.peek(key) && !loader.failed.has(key)) {
      ensureWindow(entry);
      return;
    }
  }
  state.cursorExact = next;
  state.cursor = Math.floor(next);
  if (next >= state.max) setPlaying(false);
}

function loadedEarlier(entry) {
  const earlier = [];
  for (let index = entry - 1; index >= 0; index--) {
    if (state.starts[index + 1] - state.starts[index] !== SPAN_MINUTES) break;
    const span = loader.get(keyOf(index));
    if (!span) break;
    earlier.push({ key: keyOf(index), span });
  }
  return earlier;
}

function requestOlderForTrades(entry, loadedCount, tradeCount) {
  if (tradeCount >= RECENT_TRADE_LIMIT || loadedCount >= MAX_TRADE_LOOKBACK_SPANS) return false;
  const older = entry - loadedCount - 1;
  if (older < 0 || state.starts[older + 1] - state.starts[older] !== SPAN_MINUTES) return false;
  const key = keyOf(older);
  loader.protectedKeys.add(key);
  loader.request(key, urlOf(older));
  return !loader.failed.has(key);
}

function draw() {
  const entry = entryIndexAt(state.starts, state.cursor);
  let frame;
  let waitingForOlderSpan = false;
  if (entry < 0) {
    frame = emptyFrame(state.cursor);
    setStatus("이 시각의 구간 파일이 없습니다");
  } else {
    if (entry !== state.windowEntry) ensureWindow(entry);
    const key = keyOf(entry);
    const current = loader.get(key);
    if (current) {
      const earlier = loadedEarlier(entry);
      frame = buildFrame({
        current: { key, span: current },
        earlier,
        timeMs: state.cursor,
        members: state.members,
      });
      waitingForOlderSpan = requestOlderForTrades(entry, earlier.length, frame.trades.value.length);
      setStatus(state.notice);
    } else if (loader.failed.has(key)) {
      frame = emptyFrame(state.cursor);
      setStatus(`구간 파일을 읽지 못했습니다: ${loader.failed.get(key)}`);
    } else {
      setStatus("구간 파일을 받는 중");
      return;
    }
  }
  view.draw(frame);
  el.clock.textContent = formatClock(state.cursor);
  el.bar.value = String(state.cursor);
  el.bar.setAttribute("aria-valuetext", formatClock(state.cursor));
  el.playhead.style.left = `${((state.cursor - state.min) / (state.max - state.min + 1)) * 100}%`;
  state.drawnCursor = state.cursor;
  state.dirty = waitingForOlderSpan;
  el.replay.dataset.cursorMs = String(state.cursor);
  setReady(!waitingForOlderSpan);
}

let lastTimestamp = 0;
let lastWasPlaying = false;

function tick(now) {
  requestAnimationFrame(tick);
  const rawStep = lastTimestamp === 0 ? 0 : now - lastTimestamp;
  lastTimestamp = now;
  if (state.playing && state.entries.length > 0) {
    if (lastWasPlaying) pushInterval(rawStep);
    lastWasPlaying = true;
    framesSinceStat += 1;
    if (framesSinceStat >= STAT_REFRESH_FRAMES) {
      framesSinceStat = 0;
      updateFrameStat();
    }
    advance(Math.min(rawStep, MAX_FRAME_STEP_MS));
  }
  if (state.entries.length > 0 && (state.dirty || state.cursor !== state.drawnCursor)) draw();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function fillSelect(select, values, selected) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      return option;
    }),
  );
  select.value = selected;
}

function selectItem(item, startMs) {
  const symbol = state.index.symbols[item];
  state.item = item;
  state.entries = symbol.spans;
  state.starts = symbol.spans.map((entry) => minutesOfStart(entry.start));
  state.min = state.starts[0] * 60_000;
  state.max = (state.starts[state.starts.length - 1] + SPAN_MINUTES) * 60_000 - 1;
  el.bar.min = String(state.min);
  el.bar.max = String(state.max);
  el.replay.dataset.item = item;
  el.item.value = item;
  state.windowEntry = -2;
  state.drawnCursor = null;
  view.invalidate();
  renderBarGaps();
  setTarget(startMs ?? state.min);
  const entry = entryIndexAt(state.starts, state.cursor);
  if (entry >= 0) ensureWindow(entry);
  requestGapFiles();
}

const fetchDayIndex = latestOnly((date) => fetchJson(`/data/${date}/index.json`));

async function selectDate(date, wantedItem, startMs) {
  setReady(false);
  setStatus("목록을 받는 중");
  el.date.value = date;
  let index;
  try {
    index = await fetchDayIndex(date);
  } catch (error) {
    el.date.value = state.date ?? "";
    state.notice = `${date}의 목록을 받지 못했습니다: ${error.message ?? error}`;
    state.dirty = true;
    setStatus(state.notice);
    return;
  }
  if (index === STALE) return;
  state.notice = "";
  state.date = date;
  el.replay.dataset.date = date;
  state.index = index;
  state.members = state.index.members ?? {};
  const items = Object.keys(state.index.symbols).sort();
  if (items.length === 0) {
    fillSelect(el.item, [], "");
    setStatus("이 날짜에 구간 파일이 있는 종목이 없습니다");
    return;
  }
  const item = items.includes(wantedItem) ? wantedItem : items[0];
  fillSelect(el.item, items, item);
  selectItem(item, startMs);
}

async function start() {
  const parameters = new URLSearchParams(location.search);
  state.dates = await fetchJson("/data/dates.json");
  if (state.dates.length === 0) {
    fillSelect(el.date, [], "");
    setStatus("복기할 날짜가 없습니다");
    return;
  }
  const requested = parameters.get("date");
  const date = state.dates.includes(requested) ? requested : state.dates[state.dates.length - 1];
  fillSelect(el.date, state.dates, date);
  await selectDate(date, parameters.get("item"), parseClock(parameters.get("t")) ?? undefined);
}

el.date.addEventListener("change", async () => {
  setPlaying(false);
  await selectDate(el.date.value, state.item).catch((error) => setStatus(String(error.message ?? error)));
  syncUrl();
});

el.item.addEventListener("change", () => {
  setPlaying(false);
  selectItem(el.item.value, clampToItem(state.cursor, el.item.value));
  syncUrl();
});

function clampToItem(ms, item) {
  const spans = state.index.symbols[item].spans;
  const first = minutesOfStart(spans[0].start) * 60_000;
  const last = (minutesOfStart(spans[spans.length - 1].start) + SPAN_MINUTES) * 60_000 - 1;
  return Math.min(Math.max(ms, first), last);
}

el.play.addEventListener("click", () => {
  if (!state.playing && state.cursor >= state.max) setTarget(state.min);
  setPlaying(!state.playing);
});

el.speed.addEventListener("change", () => {
  state.speed = Number(el.speed.value);
});

el.bar.addEventListener("input", () => setTarget(Number(el.bar.value)));
el.bar.addEventListener("change", syncUrl);

const KEY_STEPS_MS = { ArrowLeft: -1000, ArrowRight: 1000, PageDown: -60_000, PageUp: 60_000 };

el.bar.addEventListener("keydown", (event) => {
  let target = null;
  if (event.key in KEY_STEPS_MS) target = state.cursor + KEY_STEPS_MS[event.key] * (event.shiftKey && event.key.startsWith("Arrow") ? 10 : 1);
  else if (event.key === "Home") target = state.min;
  else if (event.key === "End") target = state.max;
  if (target === null) return;
  event.preventDefault();
  setTarget(target);
});
el.bar.addEventListener("keyup", syncUrl);

requestAnimationFrame(tick);
start().catch((error) => setStatus(String(error.message ?? error)));
