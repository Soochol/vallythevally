import {
  type ChartOptions,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type IChartApi,
  LineStyle,
  MismatchDirection,
  PriceScaleMode,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { AxisLabelCache } from "./axisLabelCache";
import { axisPriceFormat, type AxisGeometry } from "./axisFormat";
import { fetchBarsPage } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { FinancialsPage } from "../api/generated/FinancialsPage";
import type { Period } from "../api/generated/Period";
import type { SubErrorCode } from "../api/generated/SubErrorCode";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { ApiRequestError } from "../api/http";
import { formatPrice } from "../lib/format";
import type { Connection, MarketSocketLike } from "../api/socket";
import { isIndexCode, PERIOD_LABEL, symbolSub } from "../lib/symbol";
import { type ShownVenue, venueLabel } from "../lib/venue";
import { BarFeed, displayBars, type FetchPage, type History } from "./barFeed";
import { type CompareEntry, CompareLayer, compareVenue } from "./compare";
import { CompareLegend } from "./compareLegend";
import { extremeChange, type ExtremeTag, ExtremeTags } from "./extremeTags";
import { type Extreme, findExtremes } from "./extremes";
import { type OpenPort, openIndicatorPort } from "./indicators/client";
import { IndicatorLayer } from "./indicators/layer";
import { PanelControls } from "./panelControls";
import { type IndicatorCommand, IndicatorLegend } from "./indicators/legendRows";
import { chartIndicators, chartPanels } from "./indicators/shown";
import { isTailChange } from "./indicators/sync";
import { Legend, legendParts, ohlcRow } from "./legend";
import { addMainSeries, applyMainColors, type MainSeries, priceFormat, setMainData, updateMainBar } from "./series";
import { type ChartSettings, type Panel, type PriceScale, shownScale } from "./settings";
import { composeSnapshot, snapshotFileName } from "./snapshot";
import type { ThemeTokens } from "./theme";
import { chartTimeProjection, preserveTimeRange } from "./timeAxis";
import { formatBarTime, formatTickMark, fromChartTime, isIntraday, toChartTime } from "./time";
import type { ChartExtension, ExtensionFactory } from "./extensions";

/** 왼쪽 끝이 이 봉 수 안으로 들어오면 과거 페이지를 받는다(frontend.md §5.7). */
const LOAD_OLDER_WITHIN = 50;
const RIGHT_OFFSET = 6;
const STATUS_INTERVAL_MS = 250;

const SUB_ERROR_TEXT: Record<SubErrorCode, string> = {
  realtime_limit: "실시간 한도 초과: 조회 값만 보입니다",
  kiwoom_unavailable: "키움 조회 실패: 잠시 뒤 다시 시도합니다",
  unknown_symbol: "실시간 시세가 없는 종목: 조회 값만 보입니다",
  bad_request: "실시간 구독 실패: 조회 값만 보입니다",
};

const nowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

const PRICE_MODE: Record<PriceScale, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
};

export interface CellView {
  symbol: SymbolCode;
  venue: ShownVenue | null;
  period: Period;
  settings: ChartSettings;
  info: SymbolInfo | undefined;
  previewIndicator?: string | null;
  compareNames?: Readonly<Partial<Record<SymbolCode, string>>>;
}

/** React가 그리는 칸 상태: 불러오는 중, 오류, 또는 마지막 봉(휴대폰 머리용). */
export type CellStatus =
  | { kind: "loading" }
  | {
      kind: "ready";
      latest: Bar;
      prev: Bar | null;
      isCurrent: boolean;
      olderError: ApiRequestError | null;
      olderLoading: boolean;
      /** 분봉의 가장 이른 봉이 보이고 더 받을 과거가 없다(U1: 분봉은 최근 1년까지). */
      intradayEnd: boolean;
    }
  | { kind: "error"; error: ApiRequestError };

type ReadyStatus = Extract<CellStatus, { kind: "ready" }>;

export interface ControllerDeps {
  tokens: ThemeTokens;
  onStatus: (s: CellStatus) => void;
  fetchPage?: FetchPage;
  /** 없으면 실시간 없이 조회한 봉만 그린다. */
  socket?: MarketSocketLike;
  indicators?: OpenPort;
  onIndicatorCommand?: (id: string, command: IndicatorCommand, anchor: HTMLElement) => void;
  onPanelStretch?: (stretches: Panel["stretch"][]) => void;
  onCompareRemove?: (code: SymbolCode) => void;
}

/** 칸 하나의 차트 엔진 래퍼(frontend.md §5.4). React 밖의 명령형 객체다. */
export class ChartController {
  private readonly el: HTMLElement;
  private readonly chart: IChartApi;
  private readonly axisLabels: AxisLabelCache;
  private main: MainSeries;
  private financialHoverTime: number | null = null;
  private readonly indicators: IndicatorLayer;
  private readonly panelControls: PanelControls;
  private readonly indicatorLegend: IndicatorLegend;
  private readonly compare: CompareLayer;
  private readonly compareLegend: CompareLegend;
  private readonly legend: Legend;
  private readonly extremeTags: ExtremeTags;
  get venueAnchor(): HTMLElement { return this.legend.venueAnchor; }
  private readonly feed: BarFeed;
  private readonly onStatus: (s: CellStatus) => void;
  private tokens: ThemeTokens;
  private view: CellView | null = null;
  private history: History | null = null;
  private bars: Bar[] = [];
  private hoverIndex: number | null = null;
  private ready: ReadyStatus | null = null;
  private settingData = false;
  private initialRangeEnd: number | null = null;
  private disposed = false;
  private extensions = new Set<ChartExtension>();
  private readonly pendingDraw = new Map<UnixSeconds, Bar>();
  private frame: number | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusAt = 0;
  private realtimeSeen = false;
  private realtimeLive = false;
  private lastRealtimeAt: UnixSeconds | null = null;
  private stalledAt: UnixSeconds | null = null;
  private readonly unwatch: () => void;
  private readonly resize: ResizeObserver;

  constructor(el: HTMLElement, deps: ControllerDeps) {
    this.el = el;
    this.tokens = deps.tokens;
    this.onStatus = deps.onStatus;
    this.chart = createChart(el, { ...this.chartOptions(), autoSize: true });
    this.axisLabels = new AxisLabelCache(this.chart, () => this.scheduleFrame());
    this.chart.chartElement().addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    // 주 시리즈를 바꿔 붙이는 동안 가격 pane이 비어도 라이브러리가 지우지 않게 한다. 지우면 지표 패널이 0번이 된다.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);
    this.main = addMainSeries(this.chart, "candle", this.tokens, false, this.priceAxisGeometry());
    this.legend = new Legend(el);
    this.extremeTags = new ExtremeTags(el);
    this.indicators = new IndicatorLayer(
      {
        chart: this.chart,
        tokens: () => this.tokens,
        isIndex: () => this.view !== null && isIndexCode(this.view.symbol),
        period: () => this.period(),
        requestFrame: () => this.scheduleFrame(),
        guard: (draw) => this.withDataGuard(draw),
        axisFormatted: (pane) => this.axisLabels.record(pane),
        axisCoordinates: (pane) => this.axisLabels.lastCoordinates(pane),
        axisFailed: (pane, error) => this.axisLabels.failed(pane, error),
      },
      deps.indicators ?? openIndicatorPort,
    );
    this.indicatorLegend = new IndicatorLegend(el, (id, command, anchor) => deps.onIndicatorCommand?.(id, command, anchor));
    this.compareLegend = new CompareLegend((code) => deps.onCompareRemove?.(code));
    this.legend.body.append(this.indicatorLegend.priceBox, this.compareLegend.box);
    this.resize = new ResizeObserver(() => {
      const width = this.axisWidth();
      if (this.chart.options().rightPriceScale.minimumWidth !== width) this.chart.priceScale("right").applyOptions({ minimumWidth: width });
      this.indicators.applyStretch();
      this.scheduleFrame();
    });
    this.resize.observe(el);
    this.panelControls = new PanelControls(el, this.chart, () => this.scheduleFrame(), () => {
      const shown = this.indicators.stretches();
      const drawn = this.view ? chartPanels(this.view.settings, this.view.period) : [];
      let n = 0;
      const now = (this.view?.settings.panels ?? []).map((p) => drawn.some((d) => d.id === p.id) ? shown[n++] ?? p.stretch : p.stretch);
      deps.onPanelStretch?.(now);
      this.scheduleFrame();
    });
    this.feed = new BarFeed(
      deps.fetchPage ?? fetchBarsPage,
      {
        reset: (h) => this.onReset(h),
        prepended: (h, added) => this.onPrepended(h, added),
        failed: (e) => this.onFailed(e),
        olderFailed: (e) => this.patchReady({ olderError: e, olderLoading: false }),
        olderLoading: () => this.patchReady({ olderError: null, olderLoading: true }),
        live: (h, bar) => this.onRealtime(h, bar, "live"),
        confirmed: (h, bar) => this.onRealtime(h, bar, "confirmed"),
        subError: (code) => this.legend.setNotice(code === null ? null : SUB_ERROR_TEXT[code]),
      },
      deps.socket,
    );
    this.compare = new CompareLayer(
      {
        chart: this.chart,
        tokens: () => this.tokens,
        requestFrame: () => this.scheduleFrame(),
        guard: (draw) => this.withDataGuard(draw),
      },
      deps.fetchPage ?? fetchBarsPage,
      deps.socket,
    );
    this.unwatch = deps.socket?.watch((c) => this.onConnection(c)) ?? (() => {});

    this.chart.subscribeCrosshairMove((p) => {
      const n = this.bars.length;
      this.financialHoverTime = typeof p.time === "number" ? fromChartTime(p.time) : null;
      this.hoverIndex =
        this.financialHoverTime !== null && n > 0 ? this.bars.findIndex((bar) => bar.t === this.financialHoverTime) : null;
      this.renderLegend();
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && this.initialRangeEnd !== null && Math.abs(r.to - this.initialRangeEnd) < 0.001) this.initialRangeEnd = null;
      if (this.settingData) return;
      const left = this.leftT();
      const before = left === null ? -1 : this.bars.findIndex((bar) => bar.t >= left);
      if (r && before >= 0 && before < LOAD_OLDER_WITHIN) this.feed.needOlder();
      this.updateIntradayEnd();
      this.compare.coverFrom(this.leftT());
      if (this.view?.settings.compare.length) this.renderLegend();
      this.scheduleFrame();
    });
    // 캔버스 글자는 글꼴을 다 받은 뒤 다시 그려야 Pretendard로 보인다.
    void document.fonts?.ready.then(() => {
      if (!this.disposed) this.chart.applyOptions({ layout: { fontFamily: this.tokens.fontFamily } });
    });
  }

  /** 칸의 설정을 맞춘다. 바뀐 부분만 반영한다. */
  apply(next: CellView): void {
    const prev = this.view;
    this.view = next;
    const isIndex = isIndexCode(next.symbol);
    this.legend.setHead({
      name: next.info?.name ?? next.symbol,
      sub: symbolSub(next.symbol, next.info),
      period: PERIOD_LABEL[next.period],
    });

    if (prev?.settings.style !== next.settings.style) this.recreateMain(isIndex);
    const scale = shownScale(next.settings);
    if (!prev || shownScale(prev.settings) !== scale) {
      this.chart.priceScale("right").applyOptions({ mode: PRICE_MODE[scale] });
      this.el.dataset.priceScale = scale;
    }
    if (prev?.period !== next.period) this.chart.applyOptions({ timeScale: { timeVisible: isIntraday(next.period) } });
    if (prev?.symbol !== next.symbol || prev.venue !== next.venue || prev.period !== next.period) {
      if (prev && isIndexCode(prev.symbol) !== isIndex) {
        this.main.api.applyOptions({ priceFormat: priceFormat(isIndex, this.priceAxisGeometry()) });
        this.indicators.refreshPriceFormat();
      }
      this.history = null;
      this.initialRangeEnd = null;
      this.ready = null;
      this.legend.setNotice(null);
      this.setBars([]);
      this.indicators.clear();
      this.onStatus({ kind: "loading" });
      this.feed.open({ symbol: next.symbol, venue: next.venue, period: next.period });
    }
    if (prev?.period !== next.period || prev?.settings.indicators !== next.settings.indicators || prev?.settings.panels !== next.settings.panels) {
      const configs = chartIndicators(next.settings, next.period);
      const panels = chartPanels(next.settings, next.period);
      this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), next.period, () => this.indicators.setConfigs(configs, panels)));
    }
    if (prev && prev.settings.visibleBars !== next.settings.visibleBars) this.fitInitialRange();
    if (prev?.settings.showExtremes !== next.settings.showExtremes || prev?.settings.extremeBasis !== next.settings.extremeBasis) this.scheduleFrame();
    this.indicators.setPreview(next.previewIndicator ?? null);
    this.compare.setCodes(compareEntries(next), { period: next.period, venueFor: (code) => compareVenue(code, next) });
    this.renderLegend();
  }

  setFinancials(page: FinancialsPage | null, message?: string): void {
    const draw = () => this.indicators.setFinancials(page, message);
    this.withDataGuard(() => {
      if (this.initialRangeEnd !== null) {
        draw();
        this.fitInitialRange();
      } else preserveTimeRange(this.chart.timeScale(), this.period(), draw);
    });
    this.renderLegend();
  }

  /** 같은 봉 열을 처음부터 다시 받는다(오류 뒤 `다시 시도`). */
  reload(): void {
    if (!this.view) return;
    this.ready = null;
    this.onStatus({ kind: "loading" });
    this.feed.reload();
    this.compare.reload();
  }

  /** 실패한 과거 페이지를 다시 받는다(과거 봉 오류의 `다시 시도`). */
  retryOlder(): void {
    this.patchReady({ olderError: null });
    this.feed.retryOlder();
  }

  snapshot(takenAt: number): { canvas: HTMLCanvasElement; fileName: string } | null {
    const view = this.view;
    if (!view) return null;
    const shot = this.chart.takeScreenshot(true, false);
    const n = this.bars.length;
    const bar = this.bars[n - 1];
    const head = {
      name: view.info?.name ?? view.symbol,
      sub: symbolSub(view.symbol, view.info),
      venue: venueLabel(view.symbol, view.venue),
      period: PERIOD_LABEL[view.period],
      takenAt,
      legend: bar
        ? legendParts({ bar, prev: this.bars[n - 2] ?? null, isCurrent: false, stalledAt: this.stalledAt, isIndex: isIndexCode(view.symbol), period: view.period })
        : null,
      indicators: this.indicators
        .rows(bar?.t ?? null)
        .filter((r) => r.state === "ok")
        .map((r) => ({ name: r.name, color: r.color, values: r.values })),
    };
    return {
      canvas: composeSnapshot(shot, head, this.tokens, shot.width / Math.max(1, this.el.clientWidth)),
      fileName: snapshotFileName(view.symbol, view.venue, view.period, takenAt),
    };
  }

  setTheme(tokens: ThemeTokens): void {
    this.flushPendingDraw();
    this.compare.flush(this.bars);
    this.indicators.flush();
    this.tokens = tokens;
    this.chart.applyOptions(this.chartOptions());
    applyMainColors(this.main, tokens);
    this.indicators.setTheme();
    this.compare.setTheme();
    this.renderLegend();
  }

  dispose(): void {
    this.disposed = true;
    this.chart.chartElement().removeEventListener("wheel", this.onWheel, true);
    this.extensions.forEach((ext) => ext.dispose());
    this.extensions.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.resize.disconnect();
    this.unwatch();
    this.feed.dispose();
    this.compare.dispose();
    this.indicators.dispose();
    this.indicatorLegend.dispose();
    this.panelControls.dispose();
    this.compareLegend.dispose();
    this.extremeTags.dispose();
    this.legend.dispose();
    this.chart.remove();
  }

  attach(factory: ExtensionFactory): () => void {
    const ext = factory({ el: this.el, chart: this.chart, series: () => this.main.api, bars: () => this.bars, view: () => this.view });
    this.extensions.add(ext);
    return () => { if (this.extensions.delete(ext)) ext.dispose(); };
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || event.deltaY === 0) return;
    const { handleScroll, handleScale } = this.chart.options();
    const wheelScroll = typeof handleScroll === "boolean" ? handleScroll : handleScroll.mouseWheel;
    const wheelScale = typeof handleScale === "boolean" ? handleScale : handleScale.mouseWheel;
    const timeScale = this.chart.timeScale();
    const focused = event.ctrlKey || event.metaKey;
    if (event.shiftKey && !focused) {
      if (!wheelScroll) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 32 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
      const shift = event.deltaY * unit * 0.8 / timeScale.options().barSpacing;
      timeScale.scrollToPosition(timeScale.scrollPosition() + shift, false);
      return;
    }
    if (!wheelScale) {
      if (focused) event.preventDefault();
      return;
    }
    const rightBarStaysOnScroll = !focused;
    if (timeScale.options().rightBarStaysOnScroll !== rightBarStaysOnScroll) timeScale.applyOptions({ rightBarStaysOnScroll });
  };

  private priceAxisGeometry(percent = false): AxisGeometry {
    return {
      formatted: () => this.axisLabels.record(this.main.api.getPane()),
      failed: (error) => this.axisLabels.failed(this.main.api.getPane(), error),
      toCoordinate: (value) => {
        if (!percent) return this.main.api.priceToCoordinate(value);
        const range = this.chart.timeScale().getVisibleLogicalRange();
        const first = range ? this.main.api.dataByIndex(Math.floor(range.from), MismatchDirection.NearestRight) : null;
        const base = first && "close" in first ? first.close : first && "value" in first ? first.value : null;
        return typeof base !== "number" ? null : this.main.api.priceToCoordinate(base + value / 100 * Math.abs(base));
      },
      lastCoordinates: () => this.axisLabels.lastCoordinates(this.main.api.getPane()),
    };
  }

  private axisWidth(): number {
    return matchMedia("(max-width: 767px)").matches ? 52 : 72;
  }

  private chartOptions(): DeepPartial<ChartOptions> {
    const t = this.tokens;
    const percentage = axisPriceFormat("%", 0.01, this.priceAxisGeometry(true));
    const crossLine = { color: t.crosshair, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: t.raised };
    return {
      layout: {
        background: { color: t.chartBg },
        textColor: t.text2,
        fontFamily: t.fontFamily,
        fontSize: t.fontSize,
        attributionLogo: false,
        panes: { enableResize: false, separatorColor: t.line, separatorHoverColor: t.raised },
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: crossLine, horzLine: crossLine },
      rightPriceScale: { minimumWidth: this.axisWidth(), alignLabels: true, entireTextOnly: true, borderColor: t.line, scaleMargins: { top: 0.14, bottom: 0.08 } },
      timeScale: {
        borderColor: t.line,
        rightOffset: RIGHT_OFFSET,
        timeVisible: isIntraday(this.period()),
        secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatTickMark(time as UTCTimestamp, type, this.period()),
      },
      localization: {
        locale: "ko-KR",
        percentageFormatter: percentage.formatter,
        tickmarksPercentageFormatter: percentage.tickmarksFormatter,
        timeFormatter: (time: Time) => formatBarTime(fromChartTime(time as UTCTimestamp), this.period()),
      },
    };
  }

  private period(): Period {
    return this.view?.period ?? "D";
  }

  private recreateMain(isIndex: boolean): void {
    this.indicators.flush();
    this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), this.period(), () => {
      this.chart.removeSeries(this.main.api);
      this.main = addMainSeries(this.chart, this.view?.settings.style ?? "candle", this.tokens, isIndex, this.priceAxisGeometry());
      this.extensions.forEach((ext) => ext.reattach());
      this.setBars(this.bars);
    }));
  }

  private setBars(bars: Bar[]): void {
    this.bars = bars;
    this.pendingDraw.clear();
    setMainData(this.main, bars);
    this.compare.realign(bars);
    this.exposeBarsToE2e();
  }

  private exposeBarsToE2e(): void {
    const d = this.el.dataset;
    const last = this.bars[this.bars.length - 1];
    d.barCount = String(this.bars.length);
    d.firstBarT = String(this.bars[0]?.t ?? "");
    d.lastBarT = String(last?.t ?? "");
    d.lastClose = String(last?.c ?? "");
  }

  private onRealtime(h: History, bar: Bar, kind: "live" | "confirmed"): void {
    const prev = this.bars;
    const next = displayBars(h);
    this.history = h;
    this.realtimeSeen = true;
    this.lastRealtimeAt = nowSeconds();
    if (this.realtimeLive) this.stalledAt = null;
    if (isTailChange(prev, next, bar)) {
      this.bars = next;
      this.pendingDraw.set(bar.t, bar);
    } else {
      this.withDataGuard(() => this.setBars(next));
    }
    this.indicators.advance(h, bar, kind);
    this.scheduleFrame();
    this.refreshReady();
  }

  private onConnection(c: Connection): void {
    const live = c.socket === "open" && c.status.realtime === "live";
    if (this.realtimeLive && !live && this.stalledAt === null) this.stalledAt = this.lastRealtimeAt ?? nowSeconds();
    this.realtimeLive = live;
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (this.frame !== null || this.disposed) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = null;
      this.drawFrame(time);
    });
  }

  private drawFrame(time: number): void {
    this.flushPendingDraw();
    this.compare.flush(this.bars);
    this.indicators.flush();
    if (this.axisLabels.refresh(time)) this.scheduleFrame();
    this.renderLegend();
    this.renderExtremes();
  }

  private renderExtremes(): void {
    const view = this.view;
    const last = this.bars.at(-1);
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const info = view?.settings.showExtremes && last && range ? this.main.api.barsInLogicalRange(range) : null;
    const paneWidth = this.chart.timeScale().width();
    const xOf = (index: number) => this.chart.timeScale().timeToCoordinate(toChartTime(this.bars[index]!.t));
    const onScreen = (index: number) => { const x = xOf(index); return x !== null && x >= 0 && x <= paneWidth; };
    let first = Math.max(0, Math.floor(info?.barsBefore ?? 0));
    let lastIndex = Math.min(this.bars.length - 1, this.bars.length - 1 - Math.floor(info?.barsAfter ?? 0));
    while (info && first <= lastIndex && !onScreen(first)) first++;
    while (info && lastIndex >= first && !onScreen(lastIndex)) lastIndex--;
    const found = info && findExtremes(this.bars, first, lastIndex);
    if (!view || !last || !found) return this.extremeTags.show(null, paneWidth);
    const paneHeight = this.chart.panes()[0]?.getHeight() ?? 0;
    const isIndex = isIndexCode(view.symbol);
    const tag = ({ index, price }: Extreme): ExtremeTag | null => {
      const x = xOf(index);
      const y = this.main.api.priceToCoordinate(price);
      if (x === null || y === null || y < 0 || y > paneHeight) return null;
      return { x, y, price: formatPrice(price, isIndex), change: extremeChange(price, last.c, view.settings.extremeBasis) };
    };
    this.extremeTags.show({ high: tag(found.high), low: tag(found.low) }, paneWidth);
  }

  private flushPendingDraw(): void {
    if (this.pendingDraw.size === 0) return;
    this.withDataGuard(() => {
      for (const b of this.pendingDraw.values()) updateMainBar(this.main, b);
    });
    this.pendingDraw.clear();
    this.exposeBarsToE2e();
  }

  private refreshReady(): void {
    const latest = this.bars[this.bars.length - 1];
    if (!latest) return;
    this.ready = {
      kind: "ready",
      latest,
      prev: this.bars[this.bars.length - 2] ?? null,
      isCurrent: this.history?.current?.t === latest.t,
      olderError: this.ready?.olderError ?? null,
      olderLoading: this.ready?.olderLoading ?? false,
      intradayEnd: this.ready?.intradayEnd ?? false,
    };
    if (this.statusTimer !== null) return;
    const wait = this.lastStatusAt + STATUS_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.emitReady();
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emitReady();
    }, wait);
  }

  private emitReady(): void {
    this.lastStatusAt = Date.now();
    if (this.ready) this.onStatus(this.ready);
  }

  /** setData가 보이는 범위 변경을 일으켜 과거 페이지를 연달아 받지 않게 막는다. */
  private withDataGuard(f: () => void): void {
    const outer = this.settingData;
    this.settingData = true;
    try {
      f();
    } finally {
      this.settingData = outer;
    }
  }

  private onReset(h: History): void {
    this.history = h;
    this.hoverIndex = null;
    this.financialHoverTime = null;
    this.realtimeSeen = false;
    if (this.realtimeLive) this.stalledAt = null;
    const bars = displayBars(h);
    this.withDataGuard(() => {
      this.setBars(bars);
      this.indicators.reset(h);
      this.fitInitialRange();
    });
    this.compare.coverFrom(this.leftT());
    this.renderLegend();
    const latest = bars[bars.length - 1];
    if (latest) {
      this.ready = {
        kind: "ready",
        latest,
        prev: bars[bars.length - 2] ?? null,
        isCurrent: h.current !== null && latest.t === h.current.t,
        olderError: null,
        olderLoading: false,
        intradayEnd: false,
      };
      this.onStatus(this.ready);
      this.updateIntradayEnd();
    } else {
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
  }

  private fitInitialRange(): void {
    const bars = this.bars;
    const first = bars[0];
    const last = bars.at(-1);
    if (!first || !last) return;
    const scale = this.chart.timeScale();
    const start = scale.timeToIndex(toChartTime(first.t), false);
    const end = scale.timeToIndex(toChartTime(last.t), false);
    if (start === null || end === null) return;
    const chosen = this.view?.settings.visibleBars ?? null;
    const whole = chosen === null && (this.period() === "Y" || this.period() === "Q");
    const show = chosen ?? (matchMedia("(max-width: 767px)").matches ? 90 : 130);
    this.initialRangeEnd = end + (whole ? 0.5 + Math.min(2, bars.length * 0.05) : RIGHT_OFFSET);
    scale.setVisibleLogicalRange({ from: whole ? start - 0.5 : end + 1 - show, to: this.initialRangeEnd });
  }

  private onPrepended(h: History, added: number): void {
    this.patchReady({ olderLoading: false });
    this.history = h;
    if (added === 0) return this.updateIntradayEnd();
    this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), this.period(), () => {
      this.setBars(displayBars(h));
      this.indicators.prepend(h);
    }));
    if (this.financialHoverTime !== null) this.hoverIndex = this.bars.findIndex((bar) => bar.t === this.financialHoverTime);
    this.compare.coverFrom(this.leftT());
    this.renderLegend();
    this.updateIntradayEnd();
  }

  private patchReady(patch: Partial<Pick<ReadyStatus, "olderError" | "olderLoading" | "intradayEnd">>): void {
    if (!this.ready) return;
    this.ready = { ...this.ready, ...patch };
    this.onStatus(this.ready);
  }

  private updateIntradayEnd(): void {
    if (!this.ready || !this.view) return;
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const end = isIntraday(this.view.period) && this.history?.nextBefore === null && r !== null && r.from < 0.5;
    if (end !== this.ready.intradayEnd) this.patchReady({ intradayEnd: end });
  }

  private onFailed(error: ApiRequestError): void {
    this.ready = null;
    this.history = null;
    this.setBars([]);
    this.indicators.clear();
    this.renderLegend();
    this.onStatus({ kind: "error", error });
  }

  private paneTops(): number[] {
    const top = this.el.getBoundingClientRect().top;
    return this.chart.panes().map((p) => (p.getHTMLElement()?.getBoundingClientRect().top ?? top) - top);
  }

  /** Lightweight Charts는 % 축의 0%를 `floor(보이는 논리 범위 왼쪽)` 자리의 봉으로 잡는다. */
  private leftT(): UnixSeconds | null {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!r || n === 0) return null;
    return chartTimeProjection(this.chart.timeScale(), this.period()).toTime(Math.max(0, Math.floor(r.from)));
  }

  private renderLegend(): void {
    const view = this.view;
    const i = this.hoverIndex ?? this.bars.length - 1;
    const bar = this.bars[i];
    const tops = this.paneTops();
    const panels = view ? chartPanels(view.settings, this.period()) : [];
    this.panelControls.render(panels, tops);
    this.indicatorLegend.render(this.indicators.rows(this.financialHoverTime ?? bar?.t ?? null), tops, this.chart.priceScale("right").width());
    this.compareLegend.render(this.compare.rows(this.leftT(), bar?.t ?? null));
    if (!view || !bar) return this.legend.show(null, "hidden");
    this.legend.show({
      bar,
      prev: this.bars[i - 1] ?? null,
      isCurrent: this.history?.current?.t === bar.t && !this.realtimeSeen,
      isIndex: isIndexCode(view.symbol),
      period: view.period,
      stalledAt: this.stalledAt,
    }, ohlcRow(view.settings));
  }
}

function compareEntries(view: CellView): CompareEntry[] {
  return view.settings.compare.flatMap((code, i) =>
    code === view.symbol ? [] : [{ code, slot: (i + 1) as CompareEntry["slot"], name: view.compareNames?.[code] ?? code }],
  );
}
