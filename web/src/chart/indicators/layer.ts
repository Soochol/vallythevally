import {
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  type PriceFormat,
  PriceScaleMode,
  type SeriesType,
  type Time,
} from "lightweight-charts";
import { axisPriceFormat, type AxisGeometry } from "../axisFormat";
import type { Bar } from "../../api/generated/Bar";
import type { FinancialsPage } from "../../api/generated/FinancialsPage";
import type { FinancialDetailRow } from "../financials";
import type { Period } from "../../api/generated/Period";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import type { QuoteTotalPoint } from "../../api/generated/QuoteTotalPoint";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice, formatVolume } from "../../lib/format";
import { displayBars, type History } from "../barFeed";
import { TrackedValues } from "../legendShapes";
import type { QuoteView } from "../quotes/feed";
import { barOpacityOf, type IndicatorConfig, type Panel } from "../settings";
import { indicatorColorValue, type ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { IndicatorPort, OpenPort } from "./client";
import { applyToPoints, DrawQueue, pointAtTime } from "./drawQueue";
import { FinancialIndicatorStore } from "./financialFamily";
import { isFinancial, isFinancialBar, isQuoteDepth, isQuoteTotals, isTechnical, type PlotLineId as LineId, isBarLine, lineColor, specLines, specName } from "./kinds";
import { addOverlayLine, type OverlayPoint, type OverlaySeries } from "./overlayLine";
import type { BarTuple, Columns, EngineErrorKind, EngineResult, FromWorker, LineInfo, Point } from "./protocol";
import { type QuoteFamilyDeps, QuoteIndicatorController, type QuoteTarget } from "./quoteFamily";
import { syncOp } from "./sync";

type Status = { kind: "pending" } | { kind: "ready" } | { kind: "hidden" } | { kind: "error"; error: EngineErrorKind; message: string };

type Kind = IndicatorConfig["spec"]["kind"];

type Plot = { overlay: true; series: OverlaySeries } | { overlay: false; series: ISeriesApi<"Histogram"> };

type Line = Plot & {
  priceOverlay: boolean;
  id: LineId;
  shift: number;
  barOpacity: number;
  points: Point[];
  drawnLastT: UnixSeconds | null;
  guides: IPriceLine[];
  legendValues: TrackedValues;
  legendDirty: boolean;
  legendHasGap: boolean;
};

interface Shown {
  config: IndicatorConfig;
  gen: number;
  status: Status;
  lines: Line[];
}

export interface LegendValue {
  text: string;
  color: string;
}

export interface IndicatorRow {
  id: string;
  name: string;
  color: string;
  values: LegendValue[];
  state: "ok" | "pending" | "hidden" | EngineErrorKind;
  detail?: { status: string; summary: string; rows: readonly FinancialDetailRow[]; reports: readonly FinancialReport[] };
  panel: { index: number; count: number; collapsed?: boolean } | null;
}

export interface FinancialReport { readonly label: string; readonly rows: readonly FinancialDetailRow[] }

export type PriceLegendValues = Pick<IndicatorRow, "id"> & { slots: readonly (readonly IndicatorRow["values"][number]["text"][])[] };

export interface LayerHost {
  chart: IChartApi;
  tokens(): ThemeTokens;
  isIndex(): boolean;
  isPercentScale?(): boolean;
  period(): Period;
  requestFrame(): void;
  axisFormatted(pane: ReturnType<IChartApi["panes"]>[number]): void;
  axisCoordinates(pane: ReturnType<IChartApi["panes"]>[number]): number[];
  axisFailed(pane: ReturnType<IChartApi["panes"]>[number], error: unknown): void;
  /** 시리즈에 그리는 동안 보이는 범위 변경으로 과거 페이지를 받지 않게 한다(주 시리즈의 setData와 같은 가드). */
  guard(draw: () => void): void;
}

const GUIDES: Partial<Record<Kind, number[]>> = { rsi: [70, 30], stochSlow: [80, 20] };

const tuple = (b: Bar): BarTuple => [b.t, b.o, b.h, b.l, b.c, b.v];
const volumePoint = (b: Bar): Point => ({ t: b.t, v: b.v, up: b.c >= b.o });
const isPlainVolume = (spec: IndicatorConfig["spec"]) => spec.kind === "volume" && spec.maPeriod === null;
const usesWorker = (config: IndicatorConfig) => isTechnical(config.spec) && !isPlainVolume(config.spec);

function columnsOf(bars: readonly Bar[]): Columns {
  const col = (f: (b: Bar) => number) => Float64Array.from(bars, f);
  return { t: col((b) => b.t), o: col((b) => b.o), h: col((b) => b.h), l: col((b) => b.l), c: col((b) => b.c), v: col((b) => b.v) };
}

const transferOf = (c: Columns) => [c.t.buffer, c.o.buffer, c.h.buffer, c.l.buffer, c.c.buffer, c.v.buffer];

const isVolumeOverPrice = (config: IndicatorConfig) => config.panel === "price" && config.spec.kind === "volume";
const isOverlay = (config: IndicatorConfig, id: LineId) => config.panel === "price" && !isBarLine(id) && !isVolumeOverPrice(config);
const VOLUME_OVER_PRICE_MARGINS = { top: 0.8, bottom: 0 };

function withAlpha(hex: string, alpha: number): string {
  const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`;
}

function firstAtOrAfter(bars: readonly { t: UnixSeconds }[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isQuoteTail(prev: readonly Bar[], next: readonly Bar[], bar: Bar): boolean {
  if (next[next.length - 1] !== bar) return false;
  const kept = next.length - 1;
  if (kept !== prev.length && !(kept === prev.length - 1 && prev[kept]?.t === bar.t)) return false;
  for (let i = 0; i < kept; i++) if (next[i]?.t !== prev[i]?.t) return false;
  return true;
}

const ERROR_TEXT: Record<EngineErrorKind, string> = { spec: "설정 오류", calc: "계산 오류" };
export const indicatorErrorText = (kind: EngineErrorKind) => ERROR_TEXT[kind];

export class IndicatorLayer {
  private readonly port: IndicatorPort;
  private readonly shown = new Map<string, Shown>();
  private readonly queue = new DrawQueue<Line>();
  private previewId: string | null = null;
  private configs: IndicatorConfig[] = [];
  private panels: Panel[] = [];
  private gen = 0;
  private history: History | null = null;
  private display: Bar[] = [];
  private readonly allTimes = new Set<UnixSeconds>();
  private timesDirty = true;
  private committedT: UnixSeconds | null = null;
  private broken = false;
  private readonly financialStore = new FinancialIndicatorStore();
  private readonly quotes: QuoteIndicatorController;

  attachMainSeries(series: ISeriesApi<SeriesType, Time>): void {
    this.quotes.attachMainSeries(series);
  }

  detachMainSeries(series: ISeriesApi<SeriesType, Time>): void {
    this.quotes.detachMainSeries(series);
  }

  setQuoteTarget(target: QuoteTarget | null, sync = true): void {
    this.quotes.setTarget(target, sync);
  }

  setQuoteTotals(view: QuoteView<QuoteTotalPoint> | null, from: UnixSeconds | null = null): void {
    this.quotes.setTotalsOverride(view);
    this.applyQuoteTotalsUpdate(from);
  }

  setQuoteDepths(views: ReadonlyMap<IndicatorConfig["id"], QuoteView<QuoteDepthPoint>>): void {
    this.quotes.setDepthOverrides(views);
    this.applyQuoteDepthUpdate();
  }

  setFinancials(page: FinancialsPage | null, message?: string): void {
    this.financialStore.update(page, message);
    this.timesDirty = true;
    this.host.guard(() => {
      for (const s of this.shown.values()) if (isFinancial(s.config.spec)) {
        s.status = { kind: s.config.visible ? "ready" : "hidden" };
        this.drawFinancial(s);
      }
    });
    this.host.requestFrame();
  }

  constructor(
    private readonly host: LayerHost,
    open: OpenPort,
    quoteDeps?: QuoteFamilyDeps,
  ) {
    this.port = open({ message: (m) => this.onMessage(m), broken: () => this.onBroken() });
    this.quotes = new QuoteIndicatorController(
      {
        bars: () => this.display,
        tokens: () => this.host.tokens(),
        configs: () => this.configs,
        onTotalsChanged: (_view, from) => this.applyQuoteTotalsUpdate(from),
        onDepthChanged: () => this.applyQuoteDepthUpdate(),
      },
      quoteDeps,
    );
  }

  private applyQuoteTotalsUpdate(from: UnixSeconds | null): void {
    for (const s of this.shown.values()) if (isQuoteTotals(s.config.spec)) {
      this.updateQuoteStatus(s);
      if (s.config.visible) this.syncQuoteTotals(s, from);
    }
    this.host.requestFrame();
  }

  private applyQuoteDepthUpdate(): void {
    for (const s of this.shown.values()) if (isQuoteDepth(s.config.spec)) {
      this.updateQuoteDepthStatus(s);
    }
    this.host.requestFrame();
  }

  setPreview(id: string | null): void {
    if (id === this.previewId) return;
    this.previewId = id;
    for (const s of this.shown.values()) this.styleLines(s);
  }

  setConfigs(configs: IndicatorConfig[], panels: Panel[]): void {
    try {
      this.host.guard(() => this.applyConfigs(configs, panels));
    } finally {
      this.host.requestFrame();
    }
  }

  private applyConfigs(configs: IndicatorConfig[], panels: Panel[]): void {
    this.timesDirty = true;
    const prevConfigs = this.configs;
    const prevPanels = this.panels;
    this.configs = configs;
    this.panels = panels;
    const keep = new Set(configs.map((c) => c.id));
    const dropped = [...this.shown.keys()].filter((id) => !keep.has(id));
    for (const id of dropped) this.removeShown(id);
    if (dropped.length) this.port.post({ type: "drop", chart: this.port.chart, ids: dropped });

    const panelOrderChanged = prevPanels.length !== panels.length || prevPanels.some((p, i) => p.id !== panels[i]?.id);
    const fresh: IndicatorConfig[] = [];
    for (const config of configs) {
      const s = this.shown.get(config.id);
      if (!s || s.config.spec !== config.spec) {
        if (s) {
          this.removeShown(config.id);
          this.port.post({ type: "drop", chart: this.port.chart, ids: [config.id] });
        }
        this.shown.set(config.id, { config, gen: 0, status: { kind: config.visible ? "pending" : "hidden" }, lines: [] });
        if (config.visible) fresh.push(config);
        continue;
      }
      const prev = s.config;
      s.config = config;
      if (prev.visible !== config.visible) {
        if (config.visible) {
          s.status = { kind: "pending" };
          fresh.push(config);
        } else {
          s.status = { kind: "hidden" };
          s.gen = 0;
          this.clearLines(s);
          this.port.post({ type: "drop", chart: this.port.chart, ids: [config.id] });
        }
      }
      if (prev.style !== config.style || prev.visible !== config.visible) this.styleLines(s);
      if (barOpacityOf(prev.style) !== barOpacityOf(config.style)) this.redrawBars(s);
    }
    const orderChanged = configs.length !== prevConfigs.length || configs.some((c, i) => c.id !== prevConfigs[i]?.id);
    if (panelOrderChanged || orderChanged || [...this.shown.values()].some((s) => s.lines.length === 0 && specLines(s.config.spec).length > 0)) this.rebuildSeries();
    this.applyStretch();
    this.create(fresh);
    this.quotes.syncFeeds();
    for (const s of this.shown.values()) {
      if (isFinancial(s.config.spec)) this.drawFinancial(s);
      else if (isQuoteTotals(s.config.spec)) {
        this.updateQuoteStatus(s);
        if (s.config.visible) this.syncQuoteTotals(s, null);
      } else if (isQuoteDepth(s.config.spec)) {
        this.updateQuoteDepthStatus(s);
      }
    }
  }

  reset(h: History): void {
    this.host.guard(() => this.resetNow(h));
  }

  prepend(h: History): void {
    this.host.guard(() => {
      this.load(h);
      this.redrawPriceOverlays();
    });
  }

  private resetNow(h: History, keepQuotes = false): void {
    for (const s of this.shown.values()) {
      if (keepQuotes && (isQuoteTotals(s.config.spec) || isQuoteDepth(s.config.spec))) continue;
      this.clearLines(s);
      if (s.config.visible) s.status = { kind: "pending" };
    }
    if (!keepQuotes) this.quotes.markDepthLegendsDirty();
    this.load(h, keepQuotes);
  }

  private load(h: History, keepQuotes = false): void {
    this.history = h;
    this.display = displayBars(h);
    this.timesDirty = true;
    if (!keepQuotes) this.quotes.markDepthLegendsDirty();
    this.committedT = h.bars[h.bars.length - 1]?.t ?? null;
    this.quotes.cover(this.display);
    this.create(this.configs.filter((c) => c.visible));
    for (const s of this.shown.values()) {
      if (isFinancial(s.config.spec)) this.drawFinancial(s);
      else if (isQuoteTotals(s.config.spec) && !keepQuotes) {
        this.updateQuoteStatus(s);
        if (s.config.visible) this.syncQuoteTotals(s, null);
      } else if (isQuoteDepth(s.config.spec) && !keepQuotes) {
        this.updateQuoteDepthStatus(s);
      }
    }
  }

  clear(): void {
    this.host.guard(() => this.clearNow());
  }

  private clearNow(): void {
    this.history = null;
    this.display = [];
    this.timesDirty = true;
    this.committedT = null;
    this.port.post({ type: "drop", chart: this.port.chart, ids: "all" });
    for (const s of this.shown.values()) {
      s.gen = 0;
      this.clearLines(s);
      if (s.config.visible && s.status.kind !== "error") s.status = { kind: "pending" };
    }
    this.quotes.clearDepthLegends();
  }

  advance(h: History, bar: Bar, kind: "live" | "confirmed"): void {
    const prev = this.display;
    const next = displayBars(h);
    const op = syncOp(prev, next, bar, kind, this.committedT);
    if (op === "create" || !this.history) {
      const keepQuotes = this.history !== null && isQuoteTail(prev, next, bar);
      this.host.guard(() => {
        this.resetNow(h, keepQuotes);
        if (keepQuotes) {
          this.advanceQuoteTotals(bar);
          this.quotes.advanceDepthLegends(this.configs, bar);
        }
      });
      return;
    }
    this.history = h;
    this.display = next;
    if (next.length > prev.length) this.quotes.cover(next);
    if (!this.timesDirty) this.allTimes.add(bar.t);
    if (op === "confirm") this.committedT = bar.t;
    if (next.length > prev.length || next.at(-1)?.c !== prev.at(-1)?.c) this.rebaseLeadingSpans(bar);
    const point = volumePoint(bar);
    for (const s of this.shown.values()) if (s.config.visible && isPlainVolume(s.config.spec)) {
      for (const line of s.lines) {
        const prevLen = line.points.length;
        const lastT = line.points[prevLen - 1]?.t;
        line.points = applyToPoints(line.points, { op: "update", point });
        this.updateLineLegend(line, s.config, prevLen, lastT, point);
        this.queue.push(line, { op: "update", point });
      }
    }
    this.advanceQuoteTotals(bar);
    this.quotes.advanceDepthLegends(this.configs, bar);
    if (this.configs.some((c) => c.visible && usesWorker(c)) && !this.broken) {
      this.port.post({ type: "bar", chart: this.port.chart, kind: op, bar: tuple(bar) });
    }
  }

  private advanceQuoteTotals(bar: Bar): void {
    const view = this.quotes.totalsView();
    const quotePt = view?.at(bar.t);
    if (!quotePt) return;
    const prevBar = this.display.length >= 2 ? this.display[this.display.length - 2] : undefined;
    const brk = prevBar !== undefined && !view?.at(prevBar.t);
    for (const s of this.shown.values()) if (s.config.visible && isQuoteTotals(s.config.spec)) {
      for (const line of s.lines) {
        const qp: Point = brk ? { t: bar.t, v: this.quoteValue(line, quotePt), break: true } : { t: bar.t, v: this.quoteValue(line, quotePt) };
        line.points = applyToPoints(line.points, { op: "update", point: qp });
        this.queue.push(line, { op: "update", point: qp });
      }
    }
  }

  flush(): void {
    if (this.queue.size > 0) this.host.guard(() => this.drain());
  }

  private drain(): void {
    for (const [line, p] of this.queue.drain()) {
      try {
        if (p === "redraw") this.draw(line, line.points);
        else for (const pt of p) this.put(line, pt);
      } catch (e) {
        console.error(`지표 선(${line.id})을 점 사본으로 다시 그림: ${e instanceof Error ? e.message : String(e)}`);
        this.draw(line, line.points);
      }
    }
  }

  setTheme(): void {
    this.host.guard(() => this.recolor());
  }

  private recolor(): void {
    this.drain();
    for (const s of this.shown.values()) {
      this.styleLines(s);
      if (isFinancial(s.config.spec)) this.drawFinancial(s);
      for (const line of s.lines) if (isBarLine(line.id)) this.draw(line, line.points);
    }
    this.quotes.redrawHeatmap();
  }

  refreshPriceFormat(): void {
    for (const s of this.shown.values()) for (const line of s.lines) {
      line.series.applyOptions({ priceFormat: this.priceFormat(s.config) });
      line.legendDirty = true;
    }
  }

  rows(t: UnixSeconds | null): IndicatorRow[] {
    const tokens = this.host.tokens();
    let fiscalMonthShown = false;
    return this.configs.map((config) => {
      const s = this.shown.get(config.id);
      const status = s?.status ?? { kind: "pending" };
      const state = status.kind === "error" ? status.error : status.kind === "ready" ? "ok" : status.kind;
      const lines = specLines(config.spec);
      const panelIndex = config.panel === "price" ? -1 : this.panels.findIndex((p) => p.id === config.panel);
      const collapsed = this.panels[panelIndex]?.collapsed;
      const time = collapsed ? this.display.at(-1)?.t ?? t : t;
      if (isFinancial(config.spec)) {
        const showFiscalMonth = !fiscalMonthShown;
        fiscalMonthShown = true;
        return this.financialStore.row(config, time, this.host.period(), tokens, { index: panelIndex, count: this.panels.length, collapsed }, showFiscalMonth);
      }
      if (isQuoteTotals(config.spec)) {
        const panel = panelIndex < 0 ? null : { index: panelIndex, count: this.panels.length, collapsed };
        return this.quotes.totalsRow(config, time, tokens, panel);
      }
      if (isQuoteDepth(config.spec)) {
        return this.quotes.depthRow(config, time, tokens);
      }
      const values: LegendValue[] =
        state !== "ok" || time === null || !s
          ? []
          : s.lines.map((line, i) => {
              const pt = pointAtTime(line.points, time);
              const color = isBarLine(line.id) ? tokens.text2 : indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, i));
              return { text: this.legendText(config, pt), color };
            });
      const primary = lines.findIndex((l) => !isBarLine(l));
      return {
        id: config.id,
        name: specName(config.spec),
        color: primary < 0 ? tokens.text2 : indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, primary)),
        values,
        state,
        panel: panelIndex < 0 ? null : { index: panelIndex, count: this.panels.length, collapsed },
      };
    });
  }

  priceLegendValues(): readonly PriceLegendValues[] {
    if (this.timesDirty) this.rebuildAllTimes();
    const totalTimes = this.allTimes.size;
    const rows: PriceLegendValues[] = [];
    for (const config of this.configs) {
      const shown = this.shown.get(config.id);
      const panelIndex = config.panel === "price" ? -1 : this.panels.findIndex((panel) => panel.id === config.panel);
      if (isFinancial(config.spec) || isQuoteTotals(config.spec) || panelIndex >= 0) continue;
      if (isQuoteDepth(config.spec)) {
        rows.push(this.quotes.depthPriceLegend(config, this.display));
        continue;
      }
      const slots: (readonly string[])[] = [];
      if (shown?.status.kind === "ready") {
        for (const line of shown.lines) {
          this.syncLineLegend(line, config, totalTimes);
          slots.push(line.legendValues.values);
        }
      }
      rows.push({ id: config.id, slots });
    }
    return rows;
  }

  private rebuildAllTimes(): void {
    this.allTimes.clear();
    for (const bar of this.display) this.allTimes.add(bar.t);
    for (const config of this.configs) {
      const shown = this.shown.get(config.id);
      for (const line of shown?.lines ?? []) for (const point of line.points) this.allTimes.add(point.t);
    }
    this.timesDirty = false;
  }

  private syncLineLegend(line: Line, config: IndicatorConfig, totalTimes: number): void {
    const wantGap = line.points.length < totalTimes;
    if (line.legendDirty) {
      const values = line.points.map((point) => this.legendText(config, point));
      if (wantGap) values.push("—");
      line.legendValues.syncAll(values);
      line.legendHasGap = wantGap;
      line.legendDirty = false;
      return;
    }
    if (wantGap && !line.legendHasGap) {
      line.legendValues.push("—");
      line.legendHasGap = true;
    } else if (!wantGap && line.legendHasGap) {
      line.legendValues.truncate(line.points.length);
      line.legendHasGap = false;
    }
  }

  private updateLineLegend(line: Line, config: IndicatorConfig, prevLen: number, lastT: UnixSeconds | undefined, point: Point): void {
    if (line.legendDirty) return;
    if (lastT !== undefined && point.t < lastT) return;
    const text = this.legendText(config, point);
    if (lastT === point.t) line.legendValues.setAt(prevLen - 1, text);
    else if (line.legendHasGap) line.legendValues.pushBeforeLast(text);
    else line.legendValues.push(text);
  }

  stretches(): Panel["stretch"][] {
    const panes = this.host.chart.panes();
    const base = panes[0]?.getStretchFactor() ?? 1;
    return this.panels.map((p, i) => p.collapsed ? p.stretch : (panes[i + 1]?.getStretchFactor() ?? base) / base);
  }

  dispose(): void {
    this.quotes.dispose();
    this.port.close();
    for (const id of [...this.shown.keys()]) this.removeShown(id);
  }

  private create(configs: IndicatorConfig[]): void {
    configs = configs.filter((c) => isTechnical(c.spec));
    const h = this.history;
    if (!h || configs.length === 0) return;
    const gen = ++this.gen;
    for (const c of configs) {
      const s = this.shown.get(c.id);
      if (!s) continue;
      s.gen = gen;
      if (isPlainVolume(c.spec)) {
        for (const line of s.lines) {
          this.queue.forget(line);
          line.points = this.display.map(volumePoint);
          line.legendDirty = true;
          this.draw(line, line.points);
        }
        s.status = { kind: "ready" };
      } else if (this.broken) s.status = { kind: "error", error: "calc", message: "" };
    }
    configs = configs.filter(usesWorker);
    if (this.broken || configs.length === 0) return;
    const last = this.display[this.display.length - 1];
    const current = last && last !== h.bars[h.bars.length - 1] ? tuple(last) : null;
    const cols = columnsOf(h.bars);
    this.port.post(
      {
        type: "create",
        chart: this.port.chart,
        gen,
        period: this.host.period(),
        cols,
        current,
        engines: configs.map((c) => ({ id: c.id, spec: JSON.stringify(c.spec) })),
      },
      transferOf(cols),
    );
  }

  private onMessage(m: Exclude<FromWorker, { type: "fatal" }>): void {
    this.host.guard(() => {
      if (m.type === "created") for (const r of m.results) this.accept(r, r.ok ? r.lines : null);
      else for (const r of m.results) this.accept(r, null);
    });
    this.host.requestFrame();
  }

  private accept(r: EngineResult, lines: LineInfo[] | null): void {
    const s = this.shown.get(r.id);
    if (!s || s.gen !== r.gen || s.status.kind === "hidden") return;
    if (!r.ok) {
      s.status = { kind: "error", error: r.error, message: r.message };
      s.gen = 0;
      this.timesDirty = true;
      this.clearLines(s);
      if (r.error === "spec") console.warn(`지표 설정 오류(${specName(s.config.spec)}): ${r.message}`);
      else console.error(`지표 계산 오류(${specName(s.config.spec)}): ${r.message}`);
      return;
    }
    const wasReady = s.status.kind === "ready";
    lines?.forEach((l, i) => {
      const line = s.lines[i];
      if (line) line.shift = l.shift;
    });
    s.status = { kind: "ready" };
    if (lines !== null || !wasReady) this.timesDirty = true;
    r.draws.forEach((d, i) => {
      const line = s.lines[i];
      if (!line) return;
      const prevLen = line.points.length;
      const lastT = line.points[prevLen - 1]?.t;
      const firstPoint = d.op === "update" && line.overlay && prevLen === 0;
      line.points = applyToPoints(line.points, d);
      if (lines !== null || !wasReady || d.op === "set") {
        line.legendDirty = true;
        if (d.op === "set") this.timesDirty = true;
      } else if (d.op === "update") {
        if (!this.timesDirty && !(lastT !== undefined && d.point.t < lastT)) this.allTimes.add(d.point.t);
        this.updateLineLegend(line, s.config, prevLen, lastT, d.point);
      }
      if (!lines) return this.queue.push(line, firstPoint ? { op: "set", points: line.points } : d);
      this.queue.forget(line);
      this.draw(line, line.points);
    });
  }

  private onBroken(): void {
    this.broken = true;
    this.timesDirty = true;
    this.host.guard(() => {
      for (const s of this.shown.values()) {
        if (s.status.kind === "hidden" || !usesWorker(s.config)) continue;
        s.status = { kind: "error", error: "calc", message: "" };
        s.gen = 0;
        this.clearLines(s);
      }
    });
    this.host.requestFrame();
  }

  private paneOf(config: IndicatorConfig): number {
    return config.panel === "price" ? 0 : 1 + this.panels.findIndex((p) => p.id === config.panel);
  }

  /** 빈 pane은 라이브러리가 지우므로 앞 pane부터 붙인다. */
  private rebuildSeries(): void {
    this.drain();
    const old = new Map<string, Line[]>();
    for (const [id, s] of this.shown) {
      const lines = s.lines;
      old.set(id, lines);
      s.lines = [];
      for (const line of lines) this.removeLine(line);
    }
    const ordered = [...this.configs].sort((a, b) => this.paneOf(a) - this.paneOf(b));
    for (const config of ordered) {
      const s = this.shown.get(config.id);
      if (s) s.lines = this.addLines(config, old.get(config.id) ?? []);
    }
    for (const s of this.shown.values()) {
      if (isFinancial(s.config.spec)) this.drawFinancial(s);
      else if (isQuoteTotals(s.config.spec)) {
        this.updateQuoteStatus(s);
        if (s.config.visible) {
          for (const line of s.lines) {
            line.points = this.buildQuotePoints(line, this.quotes.totalsView());
            if (line.points.length) this.draw(line, line.points);
          }
        }
      } else if (isQuoteDepth(s.config.spec)) {
        this.updateQuoteDepthStatus(s);
      } else for (const line of s.lines) if (line.points.length) this.draw(line, line.points);
    }
  }

  private addLines(config: IndicatorConfig, kept: readonly Line[]): Line[] {
    const pane = this.paneOf(config);
    return specLines(config.spec).map((id, i): Line => {
      const plot = this.addPlot(config, id, i, pane);
      const { series } = plot;
      // 새 pane은 차트 단위 rightPriceScale을 물려받는데, 가격 패널의 축 모드(%·로그)를 바꾸면 그 값도 바뀐다.
      if (pane > 0) series.priceScale().applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: id === "volume" ? { top: 0.12, bottom: 0 } : { top: 0.14, bottom: 0.08 } });
      if (isVolumeOverPrice(config)) series.priceScale().applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: VOLUME_OVER_PRICE_MARGINS });
      if (isVolumeOverPrice(config) && id === "volume") series.setSeriesOrder(0);
      const guides = i === 0 ? (GUIDES[config.spec.kind] ?? []).map((price) => series.createPriceLine(this.guide(price))) : [];
      const same = kept[i]?.id === id ? kept[i] : undefined;
      return { ...plot, priceOverlay: isOverlay(config, id), id, shift: same?.shift ?? 0, barOpacity: barOpacityOf(config.style), points: same?.points ?? [], drawnLastT: null, guides, legendValues: new TrackedValues(), legendDirty: true, legendHasGap: false };
    });
  }

  private addPlot(config: IndicatorConfig, id: LineId, i: number, pane: number): Plot {
    const options = { ...this.lineOptions(config, id, i), priceFormat: this.priceFormat(config), ...(isVolumeOverPrice(config) ? { priceScaleId: `volume:${config.id}` } : {}) };
    const bar = isFinancial(config.spec) ? isFinancialBar(config.spec.kind) : isBarLine(id);
    if (!bar) return { overlay: true, series: addOverlayLine(this.host.chart, options, pane, isOverlay(config, id)) };
    return { overlay: false, series: this.host.chart.addSeries(HistogramSeries, options, pane) };
  }

  private guide(price: number) {
    return { price, color: this.host.tokens().line, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" };
  }

  private lineOptions(config: IndicatorConfig, id: LineId, i: number) {
    const common = { visible: config.visible, priceLineVisible: false, lastValueVisible: config.panel !== "price" && i === 0 && this.firstInPanel(config), title: "" };
    if (isQuoteTotals(config.spec)) {
      const color = id === "quoteAsk" ? this.host.tokens().down : this.host.tokens().up;
      return { ...common, color, lineWidth: 2 as const, crosshairMarkerVisible: false };
    }
    const color = indicatorColorValue(this.host.tokens(), lineColor(config.spec, config.style.colors, i));
    if (isBarLine(id) || (isFinancial(config.spec) && isFinancialBar(config.spec.kind))) return common;
    const line = { ...common, color, lineWidth: config.style.width };
    return isOverlay(config, id) ? { ...line, halo: config.id === this.previewId } : { ...line, crosshairMarkerVisible: false };
  }

  private firstInPanel(config: IndicatorConfig): boolean {
    return this.configs.find((other) => other.panel === config.panel)?.id === config.id;
  }

  private styleLines(s: Shown): void {
    s.lines.forEach((line, i) => {
      line.series.applyOptions(this.lineOptions(s.config, line.id, i));
      line.guides.forEach((g) => g.applyOptions({ color: this.host.tokens().line }));
    });
  }

  private priceFormat(config: IndicatorConfig): PriceFormat {
    const financialFormat = this.financialStore.priceFormat(config, this.axisGeometry(config));
    if (financialFormat !== null) return financialFormat;
    const unit = config.spec.kind === "volume" || isQuoteTotals(config.spec) ? "volume" : config.spec.kind === "macd" || config.spec.kind === "rsi" || config.spec.kind === "stochSlow" || this.host.isIndex() ? "index" : "price";
    return axisPriceFormat(unit, 0.01, this.axisGeometry(config));
  }

  private axisGeometry(config: IndicatorConfig): AxisGeometry {
    return {
      formatted: () => {
        const series = this.shown.get(config.id)?.lines[0]?.series;
        if (series) this.host.axisFormatted(series.getPane());
      },
      failed: (error) => {
        const series = this.shown.get(config.id)?.lines[0]?.series;
        if (series) this.host.axisFailed(series.getPane(), error);
      },
      toCoordinate: (value) => this.shown.get(config.id)?.lines[0]?.series.priceToCoordinate(value) ?? null,
      lastCoordinates: () => {
        const series = this.shown.get(config.id)?.lines[0]?.series;
        return series ? this.host.axisCoordinates(series.getPane()) : [];
      },
    };
  }

  private legendText(config: IndicatorConfig, point: Point | undefined): string {
    return point ? this.format(config, point.v) : "—";
  }

  private format(config: IndicatorConfig, v: number): string {
    switch (config.spec.kind) {
      case "volume":
        return formatVolume(v);
      case "rsi":
      case "stochSlow":
      case "macd":
        return formatPrice(v, true);
      default:
        return formatPrice(v, this.host.isIndex());
    }
  }

  private drawFinancial(s: Shown): void {
    if (!isFinancial(s.config.spec)) return;
    const period = this.host.period();
    const points = this.financialStore.availablePoints(s.config.spec.kind);
    for (const line of s.lines) {
      line.points = points;
      if (line.overlay) line.series.setData(points.map((p, i) => ({ time: toChartTime(p.t), value: p.v, base: p.v, connect: i > 0 && this.financialStore.adjacent(points[i - 1]!.t, p.t, period) })));
      else line.series.setData(points.map((p) => ({ time: toChartTime(p.t), value: p.v, color: p.v >= 0 ? this.host.tokens().upVol : this.host.tokens().downVol })));
      line.drawnLastT = points.at(-1)?.t ?? null;
      line.series.applyOptions({ priceFormat: this.priceFormat(s.config) });
    }
  }

  private updateQuoteStatus(s: Shown): void {
    if (!s.config.visible) {
      s.status = { kind: "hidden" };
      return;
    }
    const state = this.quotes.totalsView()?.state ?? "loading";
    s.status = state === "loading" ? { kind: "pending" } : { kind: "ready" };
  }

  private updateQuoteDepthStatus(s: Shown): void {
    if (!s.config.visible) {
      s.status = { kind: "hidden" };
      return;
    }
    const state = this.quotes.depthView(s.config.id)?.state ?? "loading";
    s.status = state === "loading" ? { kind: "pending" } : { kind: "ready" };
  }

  private quoteValue(line: Line, pt: QuoteTotalPoint): number {
    return line.id === "quoteAsk" ? pt.ask : pt.bid;
  }

  private buildQuotePoints(line: Line, view: QuoteView<QuoteTotalPoint> | null): Point[] {
    if (!view) return [];
    const out: Point[] = [];
    let prevHad = true;
    for (let i = 0; i < this.display.length; i++) {
      const t = this.display[i]!.t;
      const pt = view.at(t);
      if (!pt) {
        prevHad = false;
        continue;
      }
      out.push(prevHad ? { t, v: this.quoteValue(line, pt) } : { t, v: this.quoteValue(line, pt), break: true });
      prevHad = true;
    }
    return out;
  }

  private syncQuoteTotals(s: Shown, from: UnixSeconds | null): void {
    const view = this.quotes.totalsView();
    if (!view || from === null) {
      for (const line of s.lines) {
        line.points = this.buildQuotePoints(line, view);
        this.queue.push(line, { op: "set", points: line.points });
      }
      return;
    }
    const start = firstAtOrAfter(this.display, from);
    for (const line of s.lines) {
      let pIdx = firstAtOrAfter(line.points, from);
      let lastDrawnT = line.points.at(-1)?.t ?? -Infinity;
      let needRedraw = false;
      const updates: { index: number | null; point: Point }[] = [];
      for (let i = start; i < this.display.length; i++) {
        const t = this.display[i]!.t;
        while (pIdx < line.points.length && line.points[pIdx]!.t < t) pIdx++;
        const existing = pIdx < line.points.length && line.points[pIdx]!.t === t ? pIdx : -1;
        const q = view.at(t);
        if (!q) {
          if (existing >= 0) {
            needRedraw = true;
            break;
          }
          continue;
        }
        const brk = i > 0 && !view.at(this.display[i - 1]!.t);
        const point: Point = brk ? { t, v: this.quoteValue(line, q), break: true } : { t, v: this.quoteValue(line, q) };
        if (existing >= 0) {
          updates.push({ index: existing, point });
          pIdx++;
        } else if (t > lastDrawnT) {
          updates.push({ index: null, point });
          lastDrawnT = t;
        } else {
          needRedraw = true;
          break;
        }
      }
      if (!needRedraw && pIdx < line.points.length) needRedraw = true;
      if (needRedraw) {
        line.points = this.buildQuotePoints(line, view);
        this.queue.push(line, { op: "set", points: line.points });
      } else {
        for (const u of updates) {
          if (u.index !== null) line.points[u.index] = u.point;
          else line.points.push(u.point);
          this.queue.push(line, { op: "update", point: u.point });
        }
      }
    }
  }

  private toOverlayPoint(pt: Point): OverlayPoint {
    return pt.break ? { time: toChartTime(pt.t), value: pt.v, base: pt.v, break: true } : { time: toChartTime(pt.t), value: pt.v, base: pt.v };
  }

  private draw(line: Line, points: readonly Point[]): void {
    if (line.overlay) line.series.setData(line.priceOverlay ? this.overlayRows(points) : points.map((pt) => this.toOverlayPoint(pt)));
    else line.series.setData(points.map((pt) => this.toChart(line, pt)));
    line.drawnLastT = points.at(-1)?.t ?? null;
  }

  private put(line: Line, pt: Point): void {
    if (line.overlay) {
      const row = line.priceOverlay ? this.overlayPoint(pt) : this.toOverlayPoint(pt);
      if (line.drawnLastT !== null && pt.t < line.drawnLastT) {
        line.series.update(row, true);
      } else {
        line.series.update(row);
        if (line.drawnLastT === null || pt.t > line.drawnLastT) line.drawnLastT = pt.t;
      }
    } else {
      line.series.update(this.toChart(line, pt));
      if (line.drawnLastT === null || pt.t > line.drawnLastT) line.drawnLastT = pt.t;
    }
  }

  private overlayRows(points: readonly Point[]): OverlayPoint[] {
    const first = points[0];
    if (!first) return [];
    const warmup = this.display.slice(0, firstAtOrAfter(this.display, first.t));
    return [...warmup.map((b) => ({ time: toChartTime(b.t), base: b.c })), ...points.map((pt) => this.overlayPoint(pt))];
  }

  private overlayPoint(pt: Point): OverlayPoint {
    const main = this.display[firstAtOrAfter(this.display, pt.t)];
    return { time: toChartTime(pt.t), value: pt.v, base: main?.t === pt.t ? main.c : pt.v };
  }

  private redrawBars(s: Shown): void {
    for (const line of s.lines) {
      line.barOpacity = barOpacityOf(s.config.style);
      if (isBarLine(line.id) && line.points.length) {
        this.queue.forget(line);
        this.draw(line, line.points);
      }
    }
  }

  private redrawPriceOverlays(): void {
    for (const s of this.shown.values()) if (usesWorker(s.config)) {
      for (const line of s.lines) if (line.priceOverlay && line.points.length) {
        this.queue.forget(line);
        this.draw(line, line.points);
      }
    }
  }

  refreshPriceOverlays(): void {
    this.host.guard(() => this.redrawPriceOverlays());
  }

  private rebaseLeadingSpans(bar: Bar): void {
    if (this.host.isPercentScale && !this.host.isPercentScale()) return;
    for (const s of this.shown.values()) {
      for (const line of s.lines) {
        if (!line.priceOverlay || line.shift <= 0 || line.points.length === 0) continue;
        if (bar.t < line.points[0]!.t) {
          this.queue.push(line, { op: "set", points: line.points });
          continue;
        }
        const pt = pointAtTime(line.points, bar.t);
        if (pt) this.queue.push(line, { op: "update", point: pt });
      }
    }
  }

  private toChart(line: Line, pt: Point) {
    const time = toChartTime(pt.t);
    if (!isBarLine(line.id)) return { time, value: pt.v };
    const t = this.host.tokens();
    if (line.id === "volume") return { time, value: pt.v, color: withAlpha(pt.up !== false ? t.up : t.down, line.barOpacity) };
    return { time, value: pt.v, color: pt.v >= 0 ? t.upVol : t.downVol };
  }

  private clearLines(s: Shown): void {
    for (const line of s.lines) {
      this.queue.forget(line);
      if (line.points.length) line.series.setData([]);
      line.points = [];
      line.drawnLastT = null;
      line.legendValues.clear();
      line.legendDirty = true;
      line.legendHasGap = false;
    }
  }

  private removeLine(line: Line): void {
    this.queue.forget(line);
    this.host.chart.removeSeries(line.series);
  }

  private removeShown(id: string): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.shown.delete(id);
    this.quotes.removeDepthLegend(id);
    for (const line of s.lines) this.removeLine(line);
  }

  applyStretch(): void {
    const panes = this.host.chart.panes();
    const height = panes.reduce((sum, pane) => sum + pane.getHeight(), 0);
    const collapsedHeight = this.panels.filter((p) => p.collapsed).length * 30;
    const expandedStretch = 1 + this.panels.reduce((sum, p) => sum + (p.collapsed ? 0 : p.stretch), 0);
    const priceHeight = Math.max(30, (height - collapsedHeight) / expandedStretch);
    panes[0]?.setStretchFactor(1);
    this.panels.forEach((p, i) => {
      panes[i + 1]?.setStretchFactor(p.collapsed ? 30 / priceHeight : p.stretch);
      const element = panes[i + 1]?.getHTMLElement();
      if (element) element.style.visibility = p.collapsed ? "hidden" : "";
    });
  }
}

