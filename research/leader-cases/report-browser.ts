import { CandlestickSeries, createChart, CrosshairMode, HistogramSeries, LineSeries, LineType, type IChartApi, type ISeriesApi, type SeriesType, type Time, type IRange, type LogicalRange } from "lightweight-charts";
import type { Bundle } from "./bundle-types.ts";
import type { Manuscript } from "./manuscript.ts";
import { accountingPlots, calendarFor, FINANCIAL_FIELDS, reportPanels, type Panel } from "./report-model.ts";
import { plotRuns } from "./chart-data.ts";

interface LiveChart {
  chart: IChartApi;
  frame: HTMLElement;
  overlay: HTMLElement;
  date: HTMLOutputElement;
  series: Array<{ title: string; api: ISeriesApi<SeriesType> }>;
  linked: boolean;
  calendar: string[];
  panel: Panel;
}
interface Inspection {
  id: string;
  range: IRange<Time> | null;
  cursor: string | null;
  cursorX: number | null;
  milestones: Array<{ day: string; x: number | null }>;
  series: Array<{ title: string; data: readonly unknown[] }>;
}
declare global { interface Window { leaderReport: { inspect: () => Inspection[] } } }

const payload: { bundle: Bundle; manuscript: Manuscript } = JSON.parse(document.getElementById("report-data")!.textContent!);
const { bundle, manuscript } = payload;
const panels = reportPanels(bundle);
const calendar = calendarFor(panels, bundle, manuscript);
const observationDays = [...new Set([...bundle.calendar, ...bundle.prices.flatMap((p) => p.kind === "ok" ? p.data.daily.map((d) => d.day) : [])])].sort();
const charts = new Map<string, LiveChart>();
let range: IRange<Time> = { from: calendar[0] ?? bundle.range.from, to: bundle.range.to };
let logicalRange: LogicalRange | null = null;
let cursor: string | null = null;
let updatingRange = false;
let rangeOwner: string | null = null;
const colors = ["#205b9c", "#ad4c26", "#347958", "#8758a0", "#8c741f", "#777"];
const milestones = Object.entries(manuscript.milestones).map(([kind, value]) => ({ kind, day: value.day, title: kind === "birth" ? "탄생일" : kind === "peak" ? "정점" : "소멸일" }));
const events = [...manuscript.events.map((e) => ({ day: e.publishedOn, title: e.title, kind: "event" })), ...(bundle.dart.disclosures.kind === "ok" ? bundle.dart.disclosures.data.map((d) => ({ day: d.filedOn, title: d.title, kind: "disclosure" })) : [])];
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function timeString(time: Time | undefined | null): string | null {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  return time ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}` : null;
}
function decorations(live: LiveChart) {
  const scale = live.chart.timeScale();
  live.overlay.replaceChildren();
  if (live.linked) {
    const marketSymbol = bundle.symbol.kind === "ok" && bundle.symbol.data.market === "kosdaq" ? "IDX:101" : "IDX:001";
    const market = bundle.markets.find((m) => m.symbol === marketSymbol);
    const regimes: Array<{ from: string; to: string; kind: string }> = [];
    for (const d of market?.days ?? []) {
      const end = calendar[calendar.indexOf(d.day) + 1] ?? d.day;
      const previous = regimes.at(-1);
      if (d.regime && previous?.kind === d.regime && previous.to === d.day) previous.to = end;
      else if (d.regime) regimes.push({ from: d.day, to: end, kind: d.regime });
    }
    for (const r of regimes) {
      const from = scale.timeToCoordinate(r.from), to = scale.timeToCoordinate(r.to);
      if (from === null || to === null) continue;
      const band = element("div", "", `regime ${r.kind}`);
      band.title = `${marketSymbol} ${r.kind} ${r.from} ~ ${r.to}`;
      band.style.left = `${from}px`; band.style.width = `${Math.max(1, to - from)}px`;
      live.overlay.append(band);
    }
    for (const e of events) {
      const x = scale.timeToCoordinate(e.day);
      if (x === null) continue;
      const mark = element("div", e.kind === "event" ? "사건" : "공시", "event-line");
      mark.dataset.kind = e.kind; mark.dataset.day = e.day; mark.title = `${e.day} ${e.title}`; mark.style.left = `${x}px`;
      live.overlay.append(mark);
    }
  }
  for (const m of milestones) {
    const x = scale.timeToCoordinate(m.day);
    const mark = element("div", "", "milestone");
    mark.dataset.day = m.day; mark.dataset.kind = m.kind; mark.hidden = x === null;
    if (x !== null) mark.style.left = `${x}px`;
    mark.append(element("span", `${m.title} ${m.day}`));
    live.overlay.append(mark);
  }
  const x = cursor && live.linked ? scale.timeToCoordinate(cursor) : null;
  const marker = element("div", "", "date-cursor");
  marker.hidden = x === null;
  if (x !== null) marker.style.left = `${x}px`;
  live.overlay.append(marker);
  if (live.linked) {
    const values = cursor ? live.panel.plots.map((plot) => {
      const point = plot.sampling === "disclosure" ? plot.samples.findLast((s) => s.day <= cursor!) : plot.samples.find((s) => s.day === cursor);
      return `${plot.title}: ${point?.value === null || !point ? `자료 없음 (${point?.reason ?? "해당일 관측 없음"})` : `${point.value.toLocaleString("ko-KR")} ${plot.unit}`}`;
    }).join(" · ") : "";
    const flow = live.panel.id === "institution" ? bundle.institutionCumulative.find((p) => p.day === cursor) : null;
    live.date.value = cursor ? `날짜 커서 ${cursor} · ${values}${flow ? ` · 구간 시작 ${flow.segmentStart ?? "없음"} · ${flow.reason ?? "연속 구간"}` : ""}` : "차트 위에서 날짜를 가리키세요";
    live.frame.dataset.cursor = cursor ?? "";
  }
}
function createPanel(panel: Panel, container: HTMLElement, linked: boolean, dates: string[] = calendar): LiveChart {
  const frame = element("article", "", "chart-frame"); frame.dataset.panel = panel.id;
  frame.append(element("h3", panel.title));
  const legend = element("div", panel.plots.map((p) => `${p.title} (${p.unit})`).join(" · "), "legend"); frame.append(legend);
  const missing = panel.plots.flatMap((p) => {
    const reasons = [...new Set(p.samples.filter((s) => s.value === null).map((s) => s.reason))];
    if (p.style === "dots" && !p.samples.some((s) => s.value !== null) && reasons.includes("not_a_52_week_high")) return [`${p.title}: 신고가 점 없음`];
    return p.samples.some((s) => s.value !== null) ? [] : [`${p.title}: 자료 없음 · ${reasons.join(", ") || p.emptyReason || "source_missing_or_empty"}`];
  });
  if (missing.length) frame.append(element("p", missing.join(" / "), "no-data"));
  const date = element("output"); frame.append(date);
  const host = element("div", "", "chart"); frame.append(host); container.append(frame);
  const chart = createChart(host, { autoSize: true, layout: { attributionLogo: false, fontSize: 11 }, rightPriceScale: { minimumWidth: 92 }, timeScale: { rightOffset: 0, fixLeftEdge: false, fixRightEdge: false, ignoreWhitespaceIndices: false }, crosshair: { mode: CrosshairMode.Normal, vertLine: { visible: false }, horzLine: { visible: false } } });
  const anchor = chart.addSeries(LineSeries, { visible: false, priceScaleId: "calendar-only", lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  anchor.setData(dates.map((time) => ({ time, value: Date.parse(time) / 86400000 })));
  const live: LiveChart = { chart, frame, overlay: element("div", "", "chart-overlay"), date, series: [], linked, calendar: dates, panel };
  if (panel.candles.length) {
    const api = chart.addSeries(CandlestickSeries, { lastValueVisible: false, priceLineVisible: false });
    api.setData(panel.candles.map((c) => ({ time: c.observedOn, open: c.o, high: c.h, low: c.l, close: c.c })));
    live.series.push({ title: "주봉", api });
  }
  panel.plots.forEach((p, index) => {
    const color = colors[index % colors.length]!;
    const scaleId = p.unit === panel.plots[0]?.unit ? "right" : `unit-${p.unit}`;
    const runs = plotRuns(p, dates, observationDays);
    for (const data of runs) {
      const api = p.style === "bars"
        ? chart.addSeries(HistogramSeries, { color, priceScaleId: scaleId, lastValueVisible: false, priceLineVisible: false })
        : chart.addSeries(LineSeries, { color, priceScaleId: scaleId, lineType: p.style === "step" ? LineType.WithSteps : LineType.Simple, lineVisible: p.style !== "dots", pointMarkersVisible: p.style === "dots" || data.length === 1, pointMarkersRadius: 3, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      api.setData(data);
      live.series.push({ title: p.title, api });
    }
  });
  host.append(live.overlay);
  charts.set(panel.id, live);
  chart.subscribeCrosshairMove((event) => {
    const date = timeString(event.time) ?? (event.point ? timeString(chart.timeScale().coordinateToTime(event.point.x)) : null);
    if (!linked) { live.date.value = date ? `회계기간 ${date}` : ""; return; }
    if (!date) return;
    cursor = date;
    for (const other of charts.values()) if (other.linked) decorations(other);
  });
  chart.timeScale().subscribeVisibleTimeRangeChange((next) => {
    if (!linked || !next || updatingRange || rangeOwner !== panel.id) { decorations(live); return; }
    updatingRange = true;
    try {
      range = next;
      logicalRange = chart.timeScale().getVisibleLogicalRange();
      for (const other of charts.values()) if (other.linked && other !== live && logicalRange) other.chart.timeScale().setVisibleLogicalRange(logicalRange);
      for (const other of charts.values()) if (other.linked) decorations(other);
    } finally { updatingRange = false; }
  });
  for (const event of ["pointerdown", "wheel", "dblclick"]) host.addEventListener(event, () => { rangeOwner = panel.id; }, { capture: true, passive: true });
  chart.timeScale().subscribeSizeChange(() => decorations(live));
  if (linked) {
    updatingRange = true;
    try { if (logicalRange) chart.timeScale().setVisibleLogicalRange(logicalRange); else chart.timeScale().setVisibleRange(range); } finally { updatingRange = false; }
  } else chart.timeScale().fitContent();
  requestAnimationFrame(() => {
    if (charts.get(panel.id) !== live) return;
    if (linked) {
      updatingRange = true;
      try { if (logicalRange) chart.timeScale().setVisibleLogicalRange(logicalRange); else chart.timeScale().setVisibleRange(range); } finally { updatingRange = false; }
    }
    decorations(live);
  });
  decorations(live);
  return live;
}
function mount(panel: Panel) {
  const slot = document.getElementById(`slot-${panel.id}`);
  if (slot && !charts.has(panel.id)) createPanel(panel, slot, true);
}
for (const panel of panels) if (panel.defaultOpen) mount(panel);
const controls = document.getElementById("panel-controls")!;
for (const group of [...new Set(panels.filter((p) => !p.defaultOpen).map((p) => p.group))]) {
  const label = element("label", "", "group-toggle");
  const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", group);
  label.append(checkbox, document.createTextNode(` ${group}`)); controls.append(label);
  checkbox.addEventListener("change", () => {
    for (const p of panels.filter((p) => p.group === group && !p.defaultOpen)) {
      const slot = document.getElementById(`slot-${p.id}`)!;
      if (checkbox.checked) mount(p);
      else { charts.get(p.id)?.chart.remove(); charts.delete(p.id); slot.replaceChildren(); }
    }
  });
}
const accountingSelect = document.getElementById("accounting-mode");
const accountingHost = document.getElementById("accounting-charts")!;
const fieldLabel = element("label", "표시 항목 ");
const fieldSelect = element("select"); fieldSelect.id = "accounting-field"; fieldSelect.setAttribute("aria-label", "재무 항목");
const incomeOption = element("option", "매출 · 영업이익 · 영업이익률"); incomeOption.value = "income-statement"; fieldSelect.append(incomeOption);
for (const field of FINANCIAL_FIELDS) { const option = element("option", field.title.split(" / ")[0]); option.value = field.id; fieldSelect.append(option); }
fieldLabel.append(fieldSelect); accountingHost.before(fieldLabel);
function accounting() {
  if (!(accountingSelect instanceof HTMLSelectElement)) return;
  const mode = accountingSelect.value === "annual" ? "annual" : "quarterly";
  const { plots, periods } = accountingPlots(bundle, mode);
  const index = Math.max(0, FINANCIAL_FIELDS.findIndex((f) => f.id === fieldSelect.value));
  const selectedPlots = fieldSelect.value === "income-statement" ? plots.filter((_p, i) => ["revenue", "operating-profit", "operatingMarginPct"].includes(FINANCIAL_FIELDS[i]!.id)) : [plots[index]!];
  charts.get("accounting")?.chart.remove(); charts.delete("accounting"); accountingHost.replaceChildren();
  const dates = [...new Set([...periods.map((p) => p.periodEnd), ...milestones.map((m) => m.day)])].sort();
  createPanel({ id: "accounting", title: `${mode === "annual" ? "연간" : "분기"} · 회계기간 축 · ${fieldSelect.selectedOptions[0]!.textContent}`, group: "회계기간", defaultOpen: true, plots: selectedPlots, candles: [] }, accountingHost, false, dates);
  const table = element("table"); table.dataset.mode = mode;
  const head = element("tr");
  for (const title of ["회계기간", "공시일", "사용 가능일", "공시까지 걸린 날수", ...plots.map((p) => `${p.title} (${p.unit})`)]) head.append(element("th", title));
  table.append(head);
  periods.forEach((p, i) => {
    const row = element("tr");
    for (const value of [`${p.year}${mode === "annual" ? "" : `-Q${p.quarter}`}`, p.filedOn ?? "자료 없음", p.availableFrom ?? "자료 없음", p.filingLagDays === null ? "자료 없음" : `${p.filingLagDays}일`]) row.append(element("td", value));
    for (const plot of plots) { const s = plot.samples[i]!; row.append(element("td", s.value === null ? `자료 없음 · ${s.reason}` : String(s.value))); }
    table.append(row);
  });
  const scroll = element("div"); scroll.style.overflowX = "auto"; scroll.append(table);
  document.getElementById("accounting-ledger")!.replaceChildren(scroll);
}
accountingSelect?.addEventListener("change", accounting); fieldSelect.addEventListener("change", accounting); accounting();
window.leaderReport = { inspect: () => [...charts].map(([id, live]) => ({ id, range: live.chart.timeScale().getVisibleRange(), cursor: live.linked ? cursor : null, cursorX: cursor ? live.chart.timeScale().timeToCoordinate(cursor) : null, milestones: milestones.map((m) => ({ day: m.day, x: live.chart.timeScale().timeToCoordinate(m.day) })), series: live.series.map((s) => ({ title: s.title, data: s.api.data() })) })) };
document.documentElement.dataset.reportReady = "true";
