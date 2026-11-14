import {
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  type PriceFormat,
  PriceScaleMode,
} from "lightweight-charts";
import { axisPriceFormat, financialAxisUnit, type AxisGeometry } from "../axisFormat";
import type { Bar } from "../../api/generated/Bar";
import type { FinancialsPage } from "../../api/generated/FinancialsPage";
import { adjacentBucket, financialBuckets, financialDetail, financialFailure, financialReason, checkedTime, financialSummary, financialValue, reportingPeriod } from "../financials";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatPrice, formatVolume } from "../../lib/format";
import { displayBars, type History } from "../barFeed";
import type { IndicatorConfig, Panel } from "../settings";
import { indicatorColorValue, type ThemeTokens } from "../theme";
import { toChartTime } from "../time";
import type { IndicatorPort, OpenPort } from "./client";
import { applyToPoints, DrawQueue, pointAtTime } from "./drawQueue";
import { isFinancial, isFinancialBar, type PlotLineId as LineId, isBarLine, lineColor, specLines, specName } from "./kinds";
import { addOverlayLine, type OverlayPoint, type OverlaySeries } from "./overlayLine";
import type { BarTuple, Columns, EngineErrorKind, EngineResult, FromWorker, LineInfo, Point } from "./protocol";
import { syncOp } from "./sync";

type Status = { kind: "pending" } | { kind: "ready" } | { kind: "hidden" } | { kind: "error"; error: EngineErrorKind; message: string };

type Kind = IndicatorConfig["spec"]["kind"];

type Plot = { overlay: true; series: OverlaySeries } | { overlay: false; series: ISeriesApi<"Histogram"> };

type Line = Plot & {
  priceOverlay: boolean;
  id: LineId;
  kind: Kind;
  shift: number;
  points: Point[];
  guides: IPriceLine[];
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
  detail?: { status: string; summary: string; text: string; reports: { label: string; text: string }[] };
  panel: { index: number; count: number; collapsed?: boolean } | null;
}

export interface LayerHost {
  chart: IChartApi;
  tokens(): ThemeTokens;
  isIndex(): boolean;
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
const usesWorker = (config: IndicatorConfig) => !isFinancial(config.spec) && !isPlainVolume(config.spec);

function columnsOf(bars: readonly Bar[]): Columns {
  const col = (f: (b: Bar) => number) => Float64Array.from(bars, f);
  return { t: col((b) => b.t), o: col((b) => b.o), h: col((b) => b.h), l: col((b) => b.l), c: col((b) => b.c), v: col((b) => b.v) };
}

const transferOf = (c: Columns) => [c.t.buffer, c.o.buffer, c.h.buffer, c.l.buffer, c.c.buffer, c.v.buffer];

const isOverlay = (config: IndicatorConfig, id: LineId) => config.panel === "price" && !isBarLine(id);

function firstAtOrAfter(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  private committedT: UnixSeconds | null = null;
  private broken = false;
  private financials: FinancialsPage | null = null;
  private financialReports = new Map<string, { label: string; text: string }[]>();
  private financialSummaryText = "";
  private financialMessage = "재무자료를 불러오는 중입니다";
  private financialNotice: string | undefined;

  setFinancials(page: FinancialsPage | null, message?: string): void {
    this.financials = page;
    this.financialNotice = message;
    this.financialSummaryText = page ? financialSummary(page) : "";
    this.financialReports = new Map(page?.series.map((series) => [series.metric, series.points.map((point) => ({ label: `${point.businessYear} / ${point.reportCode} · ${reportingPeriod(point.period)}`, text: financialDetail(point, series.metric) }))]) ?? []);
    this.financialMessage = message ?? "재무자료를 불러오는 중입니다";
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
  ) {
    this.port = open({ message: (m) => this.onMessage(m), broken: () => this.onBroken() });
  }

  setPreview(id: string | null): void {
    if (id === this.previewId) return;
    this.previewId = id;
    for (const s of this.shown.values()) this.styleLines(s);
  }

  setConfigs(configs: IndicatorConfig[], panels: Panel[]): void {
    this.host.guard(() => this.applyConfigs(configs, panels));
  }

  private applyConfigs(configs: IndicatorConfig[], panels: Panel[]): void {
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
    }
    const orderChanged = configs.length !== prevConfigs.length || configs.some((c, i) => c.id !== prevConfigs[i]?.id);
    if (panelOrderChanged || orderChanged || [...this.shown.values()].some((s) => s.lines.length === 0)) this.rebuildSeries();
    this.applyStretch();
    this.create(fresh);
    for (const s of this.shown.values()) if (isFinancial(s.config.spec)) this.drawFinancial(s);
  }

  reset(h: History): void {
    this.host.guard(() => this.resetNow(h));
  }

  prepend(h: History): void {
    this.host.guard(() => this.load(h));
  }

  private resetNow(h: History): void {
    for (const s of this.shown.values()) {
      this.clearLines(s);
      if (s.config.visible) s.status = { kind: "pending" };
    }
    this.load(h);
  }

  private load(h: History): void {
    this.history = h;
    this.display = displayBars(h);
    this.committedT = h.bars[h.bars.length - 1]?.t ?? null;
    this.create(this.configs.filter((c) => c.visible));
    for (const s of this.shown.values()) if (isFinancial(s.config.spec)) this.drawFinancial(s);
  }

  clear(): void {
    this.host.guard(() => this.clearNow());
  }

  private clearNow(): void {
    this.history = null;
    this.display = [];
    this.committedT = null;
    this.port.post({ type: "drop", chart: this.port.chart, ids: "all" });
    for (const s of this.shown.values()) {
      s.gen = 0;
      this.clearLines(s);
      if (s.config.visible && s.status.kind !== "error") s.status = { kind: "pending" };
    }
  }

  advance(h: History, bar: Bar, kind: "live" | "confirmed"): void {
    const prev = this.display;
    const next = displayBars(h);
    const op = syncOp(prev, next, bar, kind, this.committedT);
    if (op === "create" || !this.history) return this.host.guard(() => this.resetNow(h));
    this.history = h;
    this.display = next;
    if (op === "confirm") this.committedT = bar.t;
    if (next.length > prev.length || next.at(-1)?.c !== prev.at(-1)?.c) this.rebaseLeadingSpans();
    const point = volumePoint(bar);
    for (const s of this.shown.values()) if (s.config.visible && isPlainVolume(s.config.spec)) {
      for (const line of s.lines) {
        line.points = applyToPoints(line.points, { op: "update", point });
        this.queue.push(line, { op: "update", point });
      }
    }
    if (this.configs.some((c) => c.visible && usesWorker(c)) && !this.broken) {
      this.port.post({ type: "bar", chart: this.port.chart, kind: op, bar: tuple(bar) });
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
  }

  refreshPriceFormat(): void {
    for (const s of this.shown.values()) for (const line of s.lines) line.series.applyOptions({ priceFormat: this.priceFormat(s.config) });
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
        const metric = config.spec.kind;
        const points = this.financials?.series.find((series) => series.metric === metric)?.points ?? [];
        const at = points.filter((p) => p.priceBucket === (collapsed ? points.at(-1)?.priceBucket : time));
        const fiscalMonth = !fiscalMonthShown && this.financials?.fiscalMonth ? ` · ${this.financials.fiscalMonth}월 결산` : "";
        fiscalMonthShown = true;
        const summary = this.financials ? [this.financialSummaryText, this.financialNotice].filter(Boolean).join(" · ") : this.financialMessage;
        const unitNote = metric === "dps" && this.host.period() === "Q" ? " · 연간 전용" : "";
        return { id: config.id, name: `${specName(config.spec)}${fiscalMonth}${unitNote}`, color: indicatorColorValue(tokens, config.style.colors[0] ?? "ind-1"),
          values: at.map((p) => ({ text: p.value === null ? financialReason(p.reason) || "—" : financialValue(p.value, metric, p.currency), color: tokens.text2 })),
          state: config.visible ? "ok" : "hidden", panel: { index: panelIndex, count: this.panels.length, collapsed },
          detail: { status: this.financialNotice ? "failed" : this.financials?.status ?? "pending", summary, text: [summary, financialFailure(this.financials?.failure ?? null), financialFailure(this.financials?.disclosureFailure ?? null), this.financials ? `최근 시도 ${checkedTime(this.financials.lastAttemptAt)}` : "", this.financials?.shareClassReason ? "배당 주식 종류 미확인 · 회사 재무와 별도로 확인합니다" : "", this.financials?.latestCorrections ? "정정된 최신 공시 기준" : "", ...at.map((p) => financialDetail(p, metric))].join("\n\n"),
            reports: this.financialReports.get(metric) ?? [] } };
      }
      const values: LegendValue[] =
        state !== "ok" || time === null || !s
          ? []
          : s.lines.map((line, i) => {
              const pt = pointAtTime(line.points, time);
              const color = isBarLine(line.id) ? tokens.text2 : indicatorColorValue(tokens, lineColor(config.spec, config.style.colors, i));
              return { text: pt ? this.format(config, pt.v) : "—", color };
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

  stretches(): Panel["stretch"][] {
    const panes = this.host.chart.panes();
    const base = panes[0]?.getStretchFactor() ?? 1;
    return this.panels.map((p, i) => p.collapsed ? p.stretch : (panes[i + 1]?.getStretchFactor() ?? base) / base);
  }

  dispose(): void {
    this.port.close();
    for (const id of [...this.shown.keys()]) this.removeShown(id);
  }

  private create(configs: IndicatorConfig[]): void {
    configs = configs.filter((c) => !isFinancial(c.spec));
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
      this.clearLines(s);
      if (r.error === "spec") console.warn(`지표 설정 오류(${specName(s.config.spec)}): ${r.message}`);
      else console.error(`지표 계산 오류(${specName(s.config.spec)}): ${r.message}`);
      return;
    }
    lines?.forEach((l, i) => {
      const line = s.lines[i];
      if (line) line.shift = l.shift;
    });
    s.status = { kind: "ready" };
    r.draws.forEach((d, i) => {
      const line = s.lines[i];
      if (!line) return;
      const firstPoint = d.op === "update" && line.overlay && line.points.length === 0;
      line.points = applyToPoints(line.points, d);
      if (!lines) return this.queue.push(line, firstPoint ? { op: "set", points: line.points } : d);
      this.queue.forget(line);
      this.draw(line, line.points);
    });
  }

  private onBroken(): void {
    this.broken = true;
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
      else for (const line of s.lines) if (line.points.length) this.draw(line, line.points);
    }
  }

  private addLines(config: IndicatorConfig, kept: readonly Line[]): Line[] {
    const pane = this.paneOf(config);
    return specLines(config.spec).map((id, i): Line => {
      const plot = this.addPlot(config, id, i, pane);
      const { series } = plot;
      // 새 pane은 차트 단위 rightPriceScale을 물려받는데, 가격 패널의 축 모드(%·로그)를 바꾸면 그 값도 바뀐다.
      if (pane > 0) series.priceScale().applyOptions({ mode: PriceScaleMode.Normal, scaleMargins: id === "volume" ? { top: 0.12, bottom: 0 } : { top: 0.14, bottom: 0.08 } });
      const guides = i === 0 ? (GUIDES[config.spec.kind] ?? []).map((price) => series.createPriceLine(this.guide(price))) : [];
      const same = kept[i]?.id === id ? kept[i] : undefined;
      return { ...plot, priceOverlay: isOverlay(config, id), id, kind: config.spec.kind, shift: same?.shift ?? 0, points: same?.points ?? [], guides };
    });
  }

  private addPlot(config: IndicatorConfig, id: LineId, i: number, pane: number): Plot {
    const options = { ...this.lineOptions(config, id, i), priceFormat: this.priceFormat(config) };
    const bar = isFinancial(config.spec) ? isFinancialBar(config.spec.kind) : isBarLine(id);
    if (!bar) return { overlay: true, series: addOverlayLine(this.host.chart, options, pane, isOverlay(config, id)) };
    return { overlay: false, series: this.host.chart.addSeries(HistogramSeries, options, pane) };
  }

  private guide(price: number) {
    return { price, color: this.host.tokens().line, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" };
  }

  private lineOptions(config: IndicatorConfig, id: LineId, i: number) {
    const color = indicatorColorValue(this.host.tokens(), lineColor(config.spec, config.style.colors, i));
    const common = { visible: config.visible, priceLineVisible: false, lastValueVisible: config.panel !== "price", title: "" };
    if (isBarLine(id) || (isFinancial(config.spec) && isFinancialBar(config.spec.kind))) return common;
    const line = { ...common, color, lineWidth: config.style.width };
    return isOverlay(config, id) ? { ...line, halo: config.id === this.previewId } : { ...line, crosshairMarkerVisible: false };
  }

  private styleLines(s: Shown): void {
    s.lines.forEach((line, i) => {
      line.series.applyOptions(this.lineOptions(s.config, line.id, i));
      line.guides.forEach((g) => g.applyOptions({ color: this.host.tokens().line }));
    });
  }

  private priceFormat(config: IndicatorConfig): PriceFormat {
    if (isFinancial(config.spec)) {
      const metric = config.spec.kind;
      const currencies = new Set(this.financials?.series.find((series) => series.metric === metric)?.points.flatMap((p) => p.currency ? [p.currency] : []));
      const currency = currencies.size === 1 ? [...currencies][0] ?? null : "원문 통화";
      return axisPriceFormat(financialAxisUnit(metric, currency), 0.01, this.axisGeometry(config));
    }
    const unit = config.spec.kind === "volume" ? "volume" : config.spec.kind === "macd" || config.spec.kind === "rsi" || config.spec.kind === "stochSlow" || this.host.isIndex() ? "index" : "price";
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
    const metric = s.config.spec.kind;
    const buckets = financialBuckets(this.financials?.series.find((series) => series.metric === metric)?.points ?? []);
    for (const line of s.lines) {
      const points = [...buckets].sort(([a], [b]) => a - b).flatMap(([t, ps]) => {
        const p = ps[0];
        return ps.length === 1 && p?.status === "available" && p.value !== null ? [{ t, v: p.value }] : [];
      });
      line.points = points;
      if (line.overlay) line.series.setData(points.map((p, i) => ({ time: toChartTime(p.t), value: p.v, base: p.v, connect: period === "Q" || period === "Y" ? i > 0 && adjacentBucket(points[i - 1]!.t, p.t, period) : false })));
      else line.series.setData(points.map((p) => ({ time: toChartTime(p.t), value: p.v, color: p.v >= 0 ? this.host.tokens().upVol : this.host.tokens().downVol })));
      line.series.applyOptions({ priceFormat: this.priceFormat(s.config) });
    }
  }

  private draw(line: Line, points: readonly Point[]): void {
    if (line.overlay) line.series.setData(line.priceOverlay ? this.overlayRows(points) : points.map((pt) => ({ time: toChartTime(pt.t), value: pt.v, base: pt.v })));
    else line.series.setData(points.map((pt) => this.toChart(line, pt)));
  }

  private put(line: Line, pt: Point): void {
    if (line.overlay) line.series.update(line.priceOverlay ? this.overlayPoint(pt) : { time: toChartTime(pt.t), value: pt.v, base: pt.v });
    else line.series.update(this.toChart(line, pt));
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

  private rebaseLeadingSpans(): void {
    for (const s of this.shown.values()) {
      for (const line of s.lines) if (line.overlay && line.shift > 0 && line.points.length) this.queue.push(line, { op: "set", points: line.points });
    }
  }

  private toChart(line: Line, pt: Point) {
    const time = toChartTime(pt.t);
    if (!isBarLine(line.id)) return { time, value: pt.v };
    const t = this.host.tokens();
    const up = line.kind === "volume" ? pt.up !== false : pt.v >= 0;
    return { time, value: pt.v, color: up ? t.upVol : t.downVol };
  }

  private clearLines(s: Shown): void {
    for (const line of s.lines) {
      this.queue.forget(line);
      if (line.points.length) line.series.setData([]);
      line.points = [];
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

