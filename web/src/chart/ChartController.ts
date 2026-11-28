import {
  type ChartOptions,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type IChartApi,
  type IRange,
  LineStyle,
  MismatchDirection,
  PriceScaleMode,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { AxisLabelCache } from "./axisLabelCache";
import { AXIS_WIDTH, axisPriceFormat, invalidateAxisMeasureCache, priceAxisWidth, type AxisGeometry } from "./axisFormat";
import type { LastPriceHost } from "./lastPriceTag";
import { fetchBarsPage, fetchJumpPage } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { DayHistory } from "../api/generated/DayHistory";
import type { FinancialsPage } from "../api/generated/FinancialsPage";
import type { InvestorNetSharesDay } from "../api/generated/InvestorNetSharesDay";
import type { KstDate } from "../api/generated/KstDate";
import type { Period } from "../api/generated/Period";
import type { ProgramSeriesPage } from "../api/generated/ProgramSeriesPage";
import type { QuoteDepthPage } from "../api/generated/QuoteDepthPage";
import type { QuoteTotalsPage } from "../api/generated/QuoteTotalsPage";
import type { SubErrorCode } from "../api/generated/SubErrorCode";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { TickCvdPage } from "../api/generated/TickCvdPage";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { MicroRange } from "../api/microSeries";
import { ApiRequestError } from "../api/http";
import { formatPrice } from "../lib/format";
import type { Connection, MarketSocketLike } from "../api/socket";
import { isIndexCode, isMinutePeriod, type MinutePeriod, PERIOD_LABEL, symbolSub } from "../lib/symbol";
import { type ShownVenue, venueLabel } from "../lib/venue";
import type { ReplayEngine, ReplayEngineFrame } from "../features/replay-page/replayEngine";
import type { ReplaySession } from "../features/replay-page/replayModel";
import { projectTickReplayBars } from "../features/tick-replay/chartBars";
import { displayBars, type FetchPage, filterRegularHistory, type History } from "./barFeed";
import { barAtRightEdge, type JumpAnchor, jumpAnchor, jumpHeld, type JumpOutcome, jumpRoute, kstDateOf, lastBarBefore } from "./barJump";
import { type CompareEntry, CompareLayer, compareVenue } from "./compare";
import { CompareLegend } from "./compareLegend";
import { CrosshairMarker } from "./crosshairMarker";
import { type BarInterval, barInterval, crosshairVisible, matchingBarTime, type PointedBar } from "./crosshairSync";
import { DaySeparators } from "./daySeparators";
import { extremeChange, type ExtremeTag, ExtremeTags } from "./extremeTags";
import { FineBars } from "./fineBars";
import { JumpBadge } from "./jumpBadge";
import { type FetchJump, JumpableFeed, keepsJumpMode } from "./jumpFeed";
import { type Extreme, findExtremes } from "./extremes";
import { type OpenPort, openIndicatorPort } from "./indicators/client";
import { isProgramFlow, isTickCvd } from "./indicators/kinds";
import { IndicatorLayer } from "./indicators/layer";
import { PanelControls } from "./panelControls";
import { PanelDnd } from "./panelDnd";
import { type IndicatorCommand, IndicatorLegend, type PaneBounds } from "./indicators/legendRows";
import { chartIndicators, chartPanels } from "./indicators/shown";
import { isTailChange } from "./indicators/sync";
import type { QuoteKey, QuoteRange } from "./quotes/feed";
import { Legend, type LegendBar, legendParts } from "./legend";
import { priceTopMargin } from "./legendProjection";
import { addMainSeries, applyMainColors, type MainSeries, priceFormat, setMainData, updateMainBar } from "./series";
import { type ChartSettings, type Panel, type PriceScale, shownScale } from "./settings";
import { composeSnapshot, snapshotFileName } from "./snapshot";
import type { ThemeTokens } from "./theme";
import { chartTimeProjection, PendingScroll, preserveTimeRange } from "./timeAxis";
import { formatBarTime, formatTickMark, fromChartTime, isIntraday, isRegularHours, toChartTime } from "./time";
import type { ChartExtension, ExtensionFactory } from "./extensions";
import { InitialRange, RIGHT_OFFSET } from "./initialRange";

/** 왼쪽 끝이 이 봉 수 안으로 들어오면 과거 페이지를 받는다(frontend.md §5.7). */
const LOAD_OLDER_WITHIN = 50;
const MAX_JUMP_PRESERVE_PAGES = 12;
const DEFAULT_PRICE_TOP_MARGIN = 0.14;
const PRICE_BOTTOM_MARGIN = 0.08;
const STATUS_INTERVAL_MS = 250;

const SUB_ERROR_TEXT: Record<SubErrorCode, string> = {
  realtime_limit: "실시간 한도 초과: 조회 값만 보입니다",
  kiwoom_unavailable: "키움 조회 실패: 잠시 뒤 다시 시도합니다",
  unknown_symbol: "실시간 시세가 없는 종목: 조회 값만 보입니다",
  bad_request: "실시간 구독 실패: 조회 값만 보입니다",
};

const nowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

function barIndexAtOrAfter(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo < bars.length ? lo : -1;
}

function barIndexAt(bars: readonly Bar[], t: UnixSeconds): number {
  const index = barIndexAtOrAfter(bars, t);
  return index >= 0 && bars[index]!.t === t ? index : -1;
}

function barIndexAfter(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < bars.length ? lo : -1;
}

const PRICE_MODE: Record<PriceScale, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
};

export interface JumpRequest {
  date: KstDate;
  interval: BarInterval;
}

export interface ChartTickReplayConfig {
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly isArchive: boolean;
}

interface ActiveChartTickReplay extends ChartTickReplayConfig {
  readonly priorBars: readonly Bar[];
  readonly priorPeriod: MinutePeriod | null;
  readonly unsub: () => void;
}

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
  fetchJump?: FetchJump;
  fetchQuoteTotals?: (key: QuoteKey, range: QuoteRange, signal: AbortSignal) => Promise<QuoteTotalsPage>;
  fetchQuoteDepth?: (key: QuoteKey, range: QuoteRange, signal: AbortSignal) => Promise<QuoteDepthPage>;
  fetchTickCvd?: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<TickCvdPage>;
  fetchProgramSeries?: (symbol: SymbolCode, period: Period, range: MicroRange, signal: AbortSignal) => Promise<ProgramSeriesPage>;
  fetchInvestorNetShares?: (symbol: SymbolCode, from: KstDate, to: KstDate, signal: AbortSignal) => Promise<DayHistory<InvestorNetSharesDay>>;
  /** 없으면 실시간 없이 조회한 봉만 그린다. */
  socket?: MarketSocketLike;
  indicators?: OpenPort;
  onIndicatorCommand?: (id: string, command: IndicatorCommand, anchor: HTMLElement) => void;
  onIndicatorMerge?: (indicatorId: string, targetPanelId: "price" | Panel["id"]) => void;
  onIndicatorSplit?: (indicatorId: string, insertAt: number) => void;
  onPanelStretch?: (stretches: Panel["stretch"][]) => void;
  onCompareRemove?: (code: SymbolCode) => void;
  onCorner?: (corner: { width: number; height: number }) => void;
  badgeHost?: HTMLElement;
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
  private readonly panelDnd: PanelDnd;
  private readonly indicatorLegend: IndicatorLegend;
  private readonly compare: CompareLayer;
  private readonly compareLegend: CompareLegend;
  private readonly legend: Legend;
  private readonly extremeTags: ExtremeTags;
  private readonly daySeparators: DaySeparators;
  private readonly crosshairMarker: CrosshairMarker;
  private readonly pointedListeners = new Set<(bar: PointedBar, close: number | null) => void>();
  private pointerOwnsCrosshair = false;
  private elVisible = false;
  private pendingPaneLayout: { panes: PaneBounds[]; axisWidth: number; leftAxisWidth: number } | null = null;
  private indicatorRowsDirty = true;
  private lastIndicatorRowTime: UnixSeconds | null = null;
  private leftAxisVisible = false;
  private lastLeftAxisWidth = 0;
  get venueAnchor(): HTMLElement { return this.legend.venueAnchor; }
  private readonly feed: JumpableFeed;
  private readonly badge: JumpBadge;
  private jumpToken = 0;
  private jumpInterval: BarInterval | null = null;
  private enteringJump: { date: KstDate; interval: BarInterval } | null = null;
  private extendingJump = false;
  private pendingEnd: UnixSeconds | null = null;
  private readonly fineBars: FineBars;
  private readonly onStatus: (s: CellStatus) => void;
  private tokens: ThemeTokens;
  private view: CellView | null = null;
  private rawHistory: History | null = null;
  private history: History | null = null;
  private bars: Bar[] = [];
  private hoverIndex: number | null = null;
  private pendingBase: "full" | number | null = "full";
  private readonly pendingLegendSources = new Set<"indicators" | "compare">(["indicators", "compare"]);
  private legendLeftT: UnixSeconds | null = null;
  private priceTopMargin = DEFAULT_PRICE_TOP_MARGIN;
  private ready: ReadyStatus | null = null;
  private settingData = false;
  private readonly initialRange: InitialRange;
  private readonly pendingScroll = new PendingScroll((callback) => requestAnimationFrame(callback));
  private disposed = false;
  private extensions = new Set<ChartExtension>();
  private readonly pendingDraw = new Map<UnixSeconds, Bar>();
  private frame: number | null = null;
  private legendFrame: number | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusAt = 0;
  private realtimeSeen = false;
  private realtimeLive = false;
  private lastRealtimeAt: UnixSeconds | null = null;
  private stalledAt: UnixSeconds | null = null;
  private readonly unwatch: () => void;
  private readonly socket: MarketSocketLike | undefined;
  private tradeFeedSub: { symbol: SymbolCode; venue: ShownVenue | null; stop: () => void } | null = null;
  private programFeedSub: { symbol: SymbolCode; stop: () => void } | null = null;
  private tickReplay: ActiveChartTickReplay | null = null;
  private readonly resize: ResizeObserver;
  private readonly hostResize: ResizeObserver;
  private readonly narrowMedia: MediaQueryList;
  private narrow: boolean;
  private paneLayoutDirty = true;
  private lastAxisWidth = -1;
  private lastPaneHeights: number[] = [];
  private lastAxisCeil: number | null = null;
  private lastAxisFontSize: number | null = null;
  private readonly onCorner: ControllerDeps["onCorner"];
  private readonly onNarrowChange = (): void => {
    this.narrow = this.narrowMedia.matches;
    this.paneLayoutDirty = true;
    this.applyAxisWidth();
    this.scheduleFrame();
  };

  constructor(el: HTMLElement, deps: ControllerDeps) {
    this.el = el;
    this.socket = deps.socket;
    this.onCorner = deps.onCorner;
    this.tokens = deps.tokens;
    this.onStatus = deps.onStatus;
    this.elVisible = crosshairVisible(el);
    this.narrowMedia = matchMedia("(max-width: 767px)");
    this.narrow = this.narrowMedia.matches;
    this.narrowMedia.addEventListener("change", this.onNarrowChange);
    this.initialRange = new InitialRange(() => this.chart.timeScale(), () => ({ width: el.clientWidth, height: el.clientHeight }));
    this.hostResize = new ResizeObserver(() => {
      this.initialRange.hostResized();
      if (this.pendingEnd !== null) requestAnimationFrame(() => this.flushPendingEnd());
    });
    this.hostResize.observe(el);
    this.chart = createChart(el, { ...this.chartOptions(), autoSize: true });
    this.axisLabels = new AxisLabelCache(this.chart, () => this.scheduleFrame(), (series) => series === this.main.api);
    this.chart.chartElement().addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    // 주 시리즈를 바꿔 붙이는 동안 가격 pane이 비어도 라이브러리가 지우지 않게 한다. 지우면 지표 패널이 0번이 된다.
    this.chart.panes()[0]?.setPreserveEmptyPane(true);
    this.main = addMainSeries(this.chart, "candle", this.tokens, false, this.lastPriceHost, this.priceAxisGeometry());
    this.crosshairMarker = new CrosshairMarker({ element: el, chart: this.chart, bars: () => this.bars, period: () => this.period() });
    el.addEventListener("pointerleave", this.clearPointedBar);
    this.legend = new Legend(el, {
      projectRows: () => [this.indicatorLegend.projection(), this.compareLegend.projection()],
      readViewport: () => ({
        pricePane: this.paneBounds()[0] ?? null,
        axisWidth: this.chart.priceScale("right").width() + this.leftAxisWidth(),
      }),
      applyTier: (tier) => this.indicatorLegend.setTier(tier),
      reserveTop: (legendBottom, paneHeight) => this.reservePriceTop(legendBottom, paneHeight),
    });
    this.extremeTags = new ExtremeTags(el);
    this.badge = new JumpBadge(deps.badgeHost ?? el, () => this.feed.endMode());
    this.daySeparators = new DaySeparators(this.chart, {
      shown: () => this.view !== null && this.view.settings.showDaySeparators && isIntraday(this.view.period),
      bars: () => this.bars,
      color: () => this.tokens.daySeparator,
    });
    this.indicators = new IndicatorLayer(
      {
        chart: this.chart,
        tokens: () => this.tokens,
        isIndex: () => this.view !== null && isIndexCode(this.view.symbol),
        isPercentScale: () => this.view !== null && shownScale(this.view.settings) === "percent",
        period: () => this.period(),
        regularHoursOnly: () => this.regularFilterActive(),
        candlesOnTop: () => this.view?.settings.candlesOnTop ?? false,
        scalePriceOnly: () => this.view?.settings.scalePriceOnly ?? false,
        priceAxisGeometry: () => this.priceAxisGeometry(),
        requestFrame: () => this.requestLegendSources("indicators"),
        guard: (draw) => this.withDataGuard(draw),
        axisFormatted: (pane, side) => this.axisLabels.record(pane, side),
        axisCoordinates: (pane, side) => this.axisLabels.lastCoordinates(pane, side),
        axisFailed: (pane, error, side) => this.axisLabels.failed(pane, error, side),
      },
      deps.indicators ?? openIndicatorPort,
      { fetchQuoteTotals: deps.fetchQuoteTotals, fetchQuoteDepth: deps.fetchQuoteDepth, now: nowSeconds },
      { fetchTickCvd: deps.fetchTickCvd, fetchProgramSeries: deps.fetchProgramSeries },
      { fetchInvestorNetShares: deps.fetchInvestorNetShares },
    );
    this.indicators.attachMainSeries(this.main.api);
    this.indicatorLegend = new IndicatorLegend(el, (id, command, anchor) => deps.onIndicatorCommand?.(id, command, anchor), () => this.legend.fit("content"));
    this.compareLegend = new CompareLegend((code) => deps.onCompareRemove?.(code));
    this.legend.body.append(this.indicatorLegend.priceBox, this.compareLegend.box);
    this.resize = new ResizeObserver(() => {
      this.paneLayoutDirty = true;
      this.elVisible = crosshairVisible(el);
      if (!this.elVisible) this.clearPointedBar();
      this.crosshairMarker.refresh();
      this.applyAxisWidth();
      this.indicators.applyStretch();
      this.reportCorner();
      this.scheduleFrame();
    });
    this.resize.observe(el);
    this.panelControls = new PanelControls(el, this.chart, () => {
      this.paneLayoutDirty = true;
      this.scheduleFrame();
    }, () => {
      this.paneLayoutDirty = true;
      const shown = this.indicators.stretches();
      const drawn = this.view ? chartPanels(this.view.settings, this.view.period, !isIndexCode(this.view.symbol)) : [];
      let n = 0;
      const now = (this.view?.settings.panels ?? []).map((p) => drawn.some((d) => d.id === p.id) ? shown[n++] ?? p.stretch : p.stretch);
      deps.onPanelStretch?.(now);
      this.scheduleFrame();
    });
    this.panelDnd = new PanelDnd(el, {
      panes: () => this.paneBounds(),
      panels: () => this.view ? chartPanels(this.view.settings, this.period(), !isIndexCode(this.view.symbol)) : [],
      configs: () => this.view ? chartIndicators(this.view.settings, this.period(), !isIndexCode(this.view.symbol)) : [],
      tokens: () => this.tokens,
      onMerge: (indicatorId, targetPanelId) => deps.onIndicatorMerge?.(indicatorId, targetPanelId),
      onSplit: (indicatorId, insertAt) => deps.onIndicatorSplit?.(indicatorId, insertAt),
    });
    this.feed = new JumpableFeed(
      deps.fetchPage ?? fetchBarsPage,
      deps.fetchJump ?? fetchJumpPage,
      {
        reset: (h) => this.onReset(h),
        jumpEntered: (h) => this.onJumpEntered(h),
        modeChanged: () => this.onModeChanged(),
        prepended: (h, added) => this.onPrepended(h, added),
        failed: (e) => this.onFailed(e),
        olderFailed: (e) => {
          if (this.ready === null) this.onFailed(e, false);
          else this.patchReady({ olderError: e, olderLoading: false });
        },
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
        requestFrame: () => this.requestLegendSources("compare"),
        guard: (draw) => this.withDataGuard(draw),
      },
      deps.fetchPage ?? fetchBarsPage,
      deps.socket,
    );
    this.fineBars = new FineBars(deps.fetchPage ?? fetchBarsPage, deps.socket);
    this.unwatch = deps.socket?.watch((c) => this.onConnection(c)) ?? (() => {});

    this.chart.subscribeCrosshairMove((p) => {
      const n = this.bars.length;
      const nextTime = typeof p.time === "number" ? fromChartTime(p.time) : null;
      const nextIndex =
        nextTime !== null && n > 0
          ? (this.hoverIndex !== null && this.bars[this.hoverIndex]?.t === nextTime ? this.hoverIndex : barIndexAt(this.bars, nextTime))
          : null;
      const changed = nextTime !== this.financialHoverTime || nextIndex !== this.hoverIndex;
      this.financialHoverTime = nextTime;
      this.hoverIndex = nextIndex;
      if (changed) this.scheduleLegendPaint();
      if (p.sourceEvent) this.pointerOwnsCrosshair = true;
      if (this.pointedListeners.size === 0 || !this.pointerOwnsCrosshair) return;
      const bar = this.hoverIndex === null ? undefined : this.bars[this.hoverIndex];
      const visible = p.point !== undefined && bar !== undefined && this.elVisible && this.el.isConnected;
      this.emitPointedBar(visible ? barInterval(bar.t, this.period()) : null, visible ? bar.c : null);
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      const r = this.chart.timeScale().getVisibleLogicalRange();
      this.initialRange.rangeChanged(r);
      if (this.settingData) return;
      const left = this.leftT();
      const before = left === null ? -1 : barIndexAtOrAfter(this.bars, left);
      if (r && before >= 0 && before < LOAD_OLDER_WITHIN && this.tickReplay === null) this.feed.needOlder();
      this.updateIntradayEnd();
      this.compare.coverFrom(this.leftT());
      if (this.view?.settings.compare.length) this.renderLegend();
      this.scheduleFrame();
    });
    // 캔버스 글자는 글꼴을 다 받은 뒤 다시 그려야 Pretendard로 보인다.
    void document.fonts?.ready.then(() => {
      if (!this.disposed) {
        invalidateAxisMeasureCache();
        this.indicatorLegend.invalidatePanelLayout();
        this.paneLayoutDirty = true;
        this.lastAxisCeil = null;
        this.chart.applyOptions({ layout: { fontFamily: this.tokens.fontFamily } });
      }
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
      regularHoursOnly: next.settings.regularHoursOnly && isIntraday(next.period),
    });

    if (prev?.settings.style !== next.settings.style) this.recreateMain(isIndex);
    const scale = shownScale(next.settings);
    if (!prev || shownScale(prev.settings) !== scale) {
      this.chart.priceScale("right").applyOptions({ mode: PRICE_MODE[scale] });
      this.el.dataset.priceScale = scale;
      if (prev && scale === "percent") this.indicators.refreshPriceOverlays();
    }
    if (prev?.period !== next.period) this.chart.applyOptions({ timeScale: { timeVisible: isIntraday(next.period) } });
    if (!prev || prev.settings.showHorzGrid !== next.settings.showHorzGrid || prev.settings.showVertGrid !== next.settings.showVertGrid) {
      this.chart.applyOptions({
        grid: {
          vertLines: { visible: next.settings.showVertGrid },
          horzLines: { visible: next.settings.showHorzGrid },
        },
      });
    }
    const targetChanged = prev?.symbol !== next.symbol || prev.venue !== next.venue || prev.period !== next.period;
    const preserveTickReplay =
      this.tickReplay !== null
      && prev !== null
      && prev.symbol === next.symbol
      && isIntraday(next.period);
    if (targetChanged) {
      if (this.tickReplay !== null && !preserveTickReplay) {
        this.detachTickReplayState();
      }
      if (!preserveTickReplay) {
        this.jumpToken++;
        this.enteringJump = null;
        this.extendingJump = false;
        const preservingJump = prev !== null && this.feed.activeDate !== null && keepsJumpMode({ symbol: prev.symbol, venue: prev.venue, period: prev.period }, { symbol: next.symbol, venue: next.venue, period: next.period });
        if (preservingJump) {
          const edge = barAtRightEdge(this.bars, this.rightEdgeT());
          const last = this.bars.at(-1);
          if (edge !== null && last !== undefined) {
            this.jumpInterval = edge.t < last.t ? barInterval(edge.t, prev.period) : null;
          }
        } else {
          this.jumpInterval = null;
        }
        if (prev && isIndexCode(prev.symbol) !== isIndex) {
          this.main.api.applyOptions({ priceFormat: priceFormat(isIndex, this.priceAxisGeometry()) });
          this.indicators.refreshPriceFormat();
        }
        this.clearPointedBar();
        this.crosshairMarker.show(null);
        this.rawHistory = null;
        this.history = null;
        this.initialRange.release();
        this.ready = null;
        this.legend.setNotice(null);
        this.setBars([]);
        this.indicators.clear();
        this.onStatus({ kind: "loading" });
        this.pendingEnd = null;
        this.feed.open({ symbol: next.symbol, venue: next.venue, period: next.period });
        this.fineBars.open({ symbol: next.symbol, venue: next.venue, period: next.period });
      } else {
        this.clearPointedBar();
        this.crosshairMarker.show(null);
        this.hoverIndex = null;
        this.financialHoverTime = null;
      }
    }
    const configsChanged = prev?.period !== next.period || (prev !== null && isIndexCode(prev.symbol) !== isIndex) || prev?.settings.indicators !== next.settings.indicators || prev?.settings.panels !== next.settings.panels;
    if (targetChanged) {
      this.indicators.setQuoteTarget({ symbol: next.symbol, venue: next.venue, period: next.period }, !configsChanged);
      this.indicators.setMicroTarget({ symbol: next.symbol, period: next.period }, !configsChanged);
      this.indicators.setInvestorTarget({ symbol: next.symbol, period: next.period }, !configsChanged);
    }
    if (configsChanged) {
      this.paneLayoutDirty = true;
      const configs = chartIndicators(next.settings, next.period, !isIndex);
      const panels = chartPanels(next.settings, next.period, !isIndex);
      this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), next.period, this.pendingScroll, () => this.indicators.setConfigs(configs, panels)));
      this.syncLeftPriceScale();
    }
    if (prev !== null && prev.settings.candlesOnTop !== next.settings.candlesOnTop) this.indicators.syncPriceOrder();
    if (prev !== null && prev.settings.scalePriceOnly !== next.settings.scalePriceOnly) this.indicators.syncPriceScale();
    if (targetChanged || configsChanged) this.syncMicroFeeds();
    if (preserveTickReplay && this.tickReplay !== null) {
      this.applyTickReplayFrame(this.tickReplay.engine.getFrame(), true);
    } else if (!targetChanged && prev !== null && prev.settings.regularHoursOnly !== next.settings.regularHoursOnly && isIntraday(next.period)) {
      if (this.tickReplay !== null) {
        this.applyTickReplayFrame(this.tickReplay.engine.getFrame(), true);
      } else if (this.rawHistory !== null) {
        this.reapplyHistory();
      }
    } else if (prev && prev.settings.visibleBars !== next.settings.visibleBars) {
      this.fitInitialRange();
    }
    if (prev?.settings.showExtremes !== next.settings.showExtremes || prev?.settings.extremeBasis !== next.settings.extremeBasis) this.scheduleFrame();
    this.indicators.setPreview(next.previewIndicator ?? null);
    this.syncCompare();
    this.renderBadge();
    this.daySeparators.sync();
    this.legend.setDisplay(next.settings);
    this.requestLegendSources("base", "indicators", "compare");
    this.renderLegend();
  }

  subscribePointedBar(listener: (bar: PointedBar, close: number | null) => void): () => void {
    if (this.pointedListeners.size === 0) this.pointerOwnsCrosshair = false;
    this.pointedListeners.add(listener);
    return () => {
      this.pointedListeners.delete(listener);
      if (this.pointedListeners.size === 0) this.pointerOwnsCrosshair = false;
    };
  }

  showSyncedCrosshair(bar: PointedBar): void {
    this.crosshairMarker.show(bar);
  }

  snapCrosshair(symbol: SymbolCode, bar: BarInterval): boolean {
    if (!this.view || this.view.symbol !== symbol || this.ready === null) return false;
    const target = matchingBarTime(bar, { bars: this.bars, period: this.period() });
    if (target !== null) {
      const targetIndex = barIndexAt(this.bars, target);
      const timeScale = this.chart.timeScale();
      const range = timeScale.getVisibleLogicalRange();
      if (targetIndex >= 0 && range !== null) {
        const x = timeScale.timeToCoordinate(toChartTime(target));
        const width = timeScale.width();
        const offscreen = x === null || !Number.isFinite(x) || x < 0 || x > width;
        if (targetIndex < range.from || targetIndex > range.to || offscreen) {
          const span = Math.max(10, range.to - range.from);
          const half = span / 2;
          const maxFrom = Math.max(0, this.bars.length - 1 + RIGHT_OFFSET - span);
          const from = Math.max(0, Math.min(targetIndex - half, maxFrom));
          this.initialRange.release();
          timeScale.setVisibleLogicalRange({ from, to: from + span });
        }
      }
    }
    this.crosshairMarker.show(bar);
    this.scheduleFrame();
    return true;
  }

  private emitPointedBar(bar: PointedBar, close: number | null): void {
    for (const listener of this.pointedListeners) listener(bar, close);
  }

  private readonly clearPointedBar = (): void => {
    this.pointerOwnsCrosshair = false;
    this.emitPointedBar(null, null);
  };

  setFinancials(page: FinancialsPage | null, message?: string): void {
    const draw = () => this.indicators.setFinancials(page, message);
    this.withDataGuard(() => {
      if (this.initialRange.held) {
        const timeScale = this.chart.timeScale();
        const userShift = this.pendingScroll.unpaintedUserShift;
        draw();
        const drawn = timeScale.getVisibleLogicalRange();
        const lastPointIndex = drawn ? drawn.to - timeScale.scrollPosition() : null;
        const fitted = this.fitInitialRange();
        if (userShift !== 0 && fitted && lastPointIndex !== null) this.pendingScroll.scrollTo(timeScale, fitted.to - lastPointIndex + userShift);
      } else preserveTimeRange(this.chart.timeScale(), this.period(), this.pendingScroll, draw);
    });
    this.requestLegendSources("indicators");
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
    const cssWidth = this.chart.chartElement().querySelector("table")?.clientWidth || this.el.clientWidth;
    return {
      canvas: composeSnapshot(shot, head, this.tokens, shot.width / Math.max(1, cssWidth)),
      fileName: snapshotFileName(view.symbol, view.venue, view.period, takenAt),
    };
  }

  setTheme(tokens: ThemeTokens): void {
    this.flushPendingDraw();
    this.reportCorner();
    this.compare.flush(this.bars);
    this.indicators.flush();
    this.tokens = tokens;
    invalidateAxisMeasureCache();
    this.indicatorLegend.invalidatePanelLayout();
    this.lastAxisCeil = null;
    this.paneLayoutDirty = true;
    this.chart.applyOptions(this.chartOptions());
    applyMainColors(this.main, tokens);
    this.indicators.setTheme();
    this.compare.setTheme();
    this.daySeparators.sync();
    this.requestLegendSources("indicators", "compare");
    this.renderLegend();
  }

  setTickReplay(config: ChartTickReplayConfig | null): void {
    if (this.disposed) return;
    if (config === null) {
      if (this.tickReplay === null) return;
      this.detachTickReplayState();
      const view = this.view;
      if (!view) return;
      this.hoverIndex = null;
      this.financialHoverTime = null;
      this.initialRange.release();
      this.ready = null;
      this.pendingDraw.clear();
      this.onStatus({ kind: "loading" });
      this.feed.open({ symbol: view.symbol, venue: view.venue, period: view.period });
      this.fineBars.open({ symbol: view.symbol, venue: view.venue, period: view.period });
      this.syncCompare();
      this.syncMicroFeeds();
      this.renderBadge();
      this.daySeparators.sync();
      return;
    }

    if (
      this.tickReplay !== null
      && this.tickReplay.engine === config.engine
    ) {
      if (this.tickReplay.session !== config.session || this.tickReplay.isArchive !== config.isArchive) {
        this.tickReplay = { ...this.tickReplay, session: config.session, isArchive: config.isArchive };
        this.applyTickReplayFrame(config.engine.getFrame(), false);
      }
      return;
    }

    const priorBars = this.tickReplay !== null
      ? this.tickReplay.priorBars
      : this.view !== null && isMinutePeriod(this.view.period)
        ? (this.rawHistory ? displayBars(this.rawHistory) : [...this.bars])
        : [];
    const priorPeriod = this.tickReplay !== null
      ? this.tickReplay.priorPeriod
      : this.view !== null && isMinutePeriod(this.view.period)
        ? this.view.period
        : null;

    if (this.tickReplay !== null) {
      this.tickReplay.unsub();
    }

    this.el.dataset.tickReplay = "active";
    this.stopMicroFeeds();
    let initialApplied = false;
    const active: ActiveChartTickReplay = {
      ...config,
      priorBars,
      priorPeriod,
      unsub: () => {},
    };
    this.tickReplay = active;
    this.syncCompare();
    this.syncMicroFeeds();
    const unsub = config.engine.subscribeFrame((frame) => {
      const refit = !initialApplied;
      initialApplied = true;
      this.applyTickReplayFrame(frame, refit);
    });
    if (this.tickReplay === active) {
      this.tickReplay = { ...active, unsub };
    } else {
      unsub();
    }
  }

  private detachTickReplayState(): void {
    if (this.tickReplay === null) return;
    this.tickReplay.unsub();
    this.tickReplay = null;
    delete this.el.dataset.tickReplay;
  }

  private applyTickReplayFrame(frame: ReplayEngineFrame, refit: boolean): void {
    const view = this.view;
    const tr = this.tickReplay;
    if (this.disposed || !view || !tr || !isMinutePeriod(view.period)) return;

    const { bars, current } = projectTickReplayBars({
      session: tr.session,
      frame,
      period: view.period,
      priorBars: tr.priorBars,
      priorPeriod: tr.priorPeriod,
      regularHoursOnly: this.regularFilterActive(),
      isArchive: tr.isArchive,
    });
    const h: History = { bars, current, nextBefore: null };
    const prev = this.bars;
    const next = displayBars(h);
    this.history = h;

    const lastNext = next[next.length - 1];
    const prevLast = prev[prev.length - 1];
    const prevSecondLast = prev[prev.length - 2];
    const nextSecondLast = next[next.length - 2];
    const sameBar = (a: Bar | undefined, b: Bar | undefined): boolean =>
      a !== undefined && b !== undefined && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
    const sameCountTail =
      !refit
      && prev.length > 0
      && next.length === prev.length
      && lastNext !== undefined
      && prevLast?.t === lastNext.t
      && (next.length < 2 || sameBar(prevSecondLast, nextSecondLast));
    const appendedTail =
      !refit
      && prev.length > 0
      && next.length === prev.length + 1
      && lastNext !== undefined
      && prevLast !== undefined
      && nextSecondLast !== undefined
      && prevLast.t === nextSecondLast.t;

    if (sameCountTail || appendedTail) {
      this.bars = next;
      if (appendedTail && !sameBar(prevLast, nextSecondLast)) {
        this.pendingDraw.set(nextSecondLast!.t, nextSecondLast!);
      }
      this.pendingDraw.set(lastNext!.t, lastNext!);
      this.exposeBarsToE2e();
      this.indicators.advance(h, lastNext!, current !== null && lastNext!.t === current.t ? "live" : "confirmed");
      this.requestTailLegendSources(next.length - 1);
    } else {
      this.hoverIndex = null;
      this.financialHoverTime = null;
      this.withDataGuard(() => {
        this.setBars(next);
        this.indicators.reset(h);
        if ((refit || prev.length === 0) && next.length > 0) this.fitInitialRange();
      });
      this.renderLegend();
    }

    this.daySeparators.sync();
    if (lastNext !== undefined) {
      const wasNull = this.ready === null;
      this.ready = {
        kind: "ready",
        latest: lastNext,
        prev: next[next.length - 2] ?? null,
        isCurrent: current !== null && lastNext.t === current.t,
        olderError: null,
        olderLoading: false,
        intradayEnd: false,
      };
      if (wasNull) this.emitReady();
      else this.refreshReady();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.detachTickReplayState();
    this.narrowMedia.removeEventListener("change", this.onNarrowChange);
    this.initialRange.forget();
    this.clearPointedBar();
    this.pointedListeners.clear();
    this.el.removeEventListener("pointerleave", this.clearPointedBar);
    this.crosshairMarker.dispose();
    this.chart.chartElement().removeEventListener("wheel", this.onWheel, true);
    this.extensions.forEach((ext) => ext.dispose());
    this.extensions.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.cancelLegendFrame();
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.resize.disconnect();
    this.hostResize.disconnect();
    this.unwatch();
    this.stopMicroFeeds();
    this.feed.dispose();
    this.el.removeAttribute("data-jump-active");
    this.badge.dispose();
    this.fineBars.dispose();
    this.compare.dispose();
    this.indicators.dispose();
    this.indicatorLegend.dispose();
    this.panelControls.dispose();
    this.panelDnd.dispose();
    this.compareLegend.dispose();
    this.extremeTags.dispose();
    this.legend.dispose();
    this.chart.remove();
  }

  attach(factory: ExtensionFactory): () => void {
    const ext = factory({ el: this.el, chart: this.chart, series: () => this.main.api, bars: () => this.bars, view: () => this.view, fineBars: this.fineBars });
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
      this.pendingScroll.scrollByUser(timeScale, shift);
      return;
    }
    if (!wheelScale) {
      if (focused) event.preventDefault();
      return;
    }
    const rightBarStaysOnScroll = !focused;
    if (timeScale.options().rightBarStaysOnScroll !== rightBarStaysOnScroll) timeScale.applyOptions({ rightBarStaysOnScroll });
  };

  private readonly lastPriceHost: LastPriceHost = {
    text: (price) => {
      if (this.view && shownScale(this.view.settings) === "percent") {
        const base = this.percentBase();
        if (base !== null) return axisPriceFormat("%", 0.01).formatter((price - base) / Math.abs(base) * 100);
      }
      return this.main.api.priceFormatter().format(price);
    },
    textColor: () => this.tokens.onData,
  };

  private percentBase(): number | null {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const first = range ? this.main.api.dataByIndex(Math.floor(range.from), MismatchDirection.NearestRight) : null;
    const base = first && "close" in first ? first.close : first && "value" in first ? first.value : null;
    return typeof base === "number" ? base : null;
  }

  private priceAxisGeometry(percent = false): AxisGeometry {
    return {
      fontSize: () => this.chart.options().layout.fontSize,
      width: () => this.axisBudgetWidth(),
      formatted: () => this.axisLabels.record(this.main.api.getPane()),
      failed: (error) => this.axisLabels.failed(this.main.api.getPane(), error),
      toCoordinate: (value) => {
        if (!percent) return this.main.api.priceToCoordinate(value);
        const base = this.percentBase();
        return base === null ? null : this.main.api.priceToCoordinate(base + value / 100 * Math.abs(base));
      },
      lastCoordinates: () => this.axisLabels.lastCoordinates(this.main.api.getPane()),
    };
  }

  private axisStep: number = AXIS_WIDTH;

  private axisWidth(): number {
    return this.narrow ? 52 : this.axisStep;
  }

  private axisBudgetWidth(): number {
    return this.narrow ? AXIS_WIDTH : this.axisStep;
  }

  private reservePriceTop(legendBottom: number, paneHeight: number): void {
    const margin = priceTopMargin(legendBottom, paneHeight);
    if (Math.abs(margin - this.priceTopMargin) * paneHeight < 0.5) return;
    this.priceTopMargin = margin;
    this.chart.priceScale("right").applyOptions({ scaleMargins: { top: margin, bottom: PRICE_BOTTOM_MARGIN } });
  }

  private leftAxisWidth(): number {
    if (!this.leftAxisVisible) return 0;
    try {
      return this.chart.priceScale("left").width();
    } catch {
      this.paneLayoutDirty = true;
      this.scheduleFrame();
      return this.axisWidth();
    }
  }

  private applyAxisWidth(): void {
    const width = this.axisWidth();
    if (this.chart.options().rightPriceScale.minimumWidth !== width) {
      this.paneLayoutDirty = true;
      this.chart.priceScale("right").applyOptions({ minimumWidth: width });
      if (this.leftAxisVisible) this.syncLeftPriceScale();
    }
  }

  private syncLeftPriceScale(): void {
    const visible = this.indicators.usesLeftAxis();
    const changed = visible !== this.leftAxisVisible;
    this.leftAxisVisible = visible;
    const options = {
      visible,
      minimumWidth: this.axisWidth(),
      alignLabels: true,
      entireTextOnly: true,
      borderColor: this.tokens.line,
    };
    this.chart.applyOptions({ leftPriceScale: options });
    for (const pane of this.chart.panes()) pane.priceScale("left").applyOptions(options);
    if (changed) this.paneLayoutDirty = true;
  }

  private rightOffset(): number {
    let offset = RIGHT_OFFSET;
    for (const config of this.view?.settings.indicators ?? []) {
      if (config.panel === "price" && config.visible && config.spec.kind === "ichimoku") {
        offset = Math.max(offset, Math.min(config.spec.displacement + 4, 32));
      }
    }
    return offset;
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
      grid: {
        vertLines: { visible: this.view?.settings.showVertGrid ?? true, color: t.grid },
        horzLines: { visible: this.view?.settings.showHorzGrid ?? true, color: t.gridH },
      },
      crosshair: { mode: CrosshairMode.Normal, vertLine: crossLine, horzLine: crossLine },
      leftPriceScale: { visible: this.leftAxisVisible, minimumWidth: this.axisWidth(), alignLabels: true, entireTextOnly: true, borderColor: t.line },
      rightPriceScale: { minimumWidth: this.axisWidth(), alignLabels: true, entireTextOnly: true, borderColor: t.line, scaleMargins: { top: this.priceTopMargin, bottom: PRICE_BOTTOM_MARGIN } },
      timeScale: {
        borderColor: t.line,
        rightOffset: this.rightOffset(),
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
    this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), this.period(), this.pendingScroll, () => {
      const replaced = this.main;
      this.indicators.detachMainSeries(replaced.api);
      this.main = addMainSeries(this.chart, this.view?.settings.style ?? "candle", this.tokens, isIndex, this.lastPriceHost, this.priceAxisGeometry());
      this.chart.removeSeries(replaced.api);
      this.indicators.attachMainSeries(this.main.api);
      this.extensions.forEach((ext) => ext.reattach());
      this.setBars(this.bars);
    }));
  }

  private setBars(bars: Bar[]): void {
    this.bars = bars;
    this.requestLegendSources("base", "indicators", "compare");
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
    d.lastHigh = String(last?.h ?? "");
    d.lastLow = String(last?.l ?? "");
    d.lastVolume = String(last?.v ?? "");
  }

  private regularFilterActive(): boolean {
    return this.view !== null && this.view.settings.regularHoursOnly && isIntraday(this.view.period);
  }

  private deriveHistory(raw: History): History {
    return this.regularFilterActive() ? filterRegularHistory(raw) : raw;
  }

  private reapplyHistory(): void {
    const raw = this.rawHistory;
    if (!raw) return;
    const h = this.deriveHistory(raw);
    this.history = h;
    const bars = displayBars(h);
    this.hoverIndex = null;
    this.financialHoverTime = null;
    this.withDataGuard(() => {
      this.setBars(bars);
      this.indicators.refilter(h);
      if (bars.length > 0) this.fitInitialRange();
    });
    this.compare.coverFrom(this.leftT());
    const latest = bars[bars.length - 1];
    if (latest) {
      this.ready = {
        kind: "ready",
        latest,
        prev: bars[bars.length - 2] ?? null,
        isCurrent: h.current !== null && latest.t === h.current.t,
        olderError: this.ready?.olderError ?? null,
        olderLoading: this.ready?.olderLoading ?? false,
        intradayEnd: false,
      };
      this.onStatus(this.ready);
      this.updateIntradayEnd();
    } else if (h.nextBefore !== null) {
      this.ready = null;
      this.onStatus({ kind: "loading" });
      this.feed.retryOlder();
    } else {
      this.ready = null;
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
  }

  private onRealtime(raw: History, bar: Bar, kind: "live" | "confirmed"): void {
    this.rawHistory = raw;
    if (this.tickReplay !== null) return;
    if (this.regularFilterActive() && !isRegularHours(bar.t)) {
      this.realtimeSeen = true;
      this.lastRealtimeAt = nowSeconds();
      return;
    }
    const h = this.deriveHistory(raw);
    const prev = this.bars;
    const next = displayBars(h);
    const prevRealtimeSeen = this.realtimeSeen;
    const prevStalledAt = this.stalledAt;
    this.history = h;
    this.realtimeSeen = true;
    this.lastRealtimeAt = nowSeconds();
    if (this.realtimeLive) this.stalledAt = null;
    const tail = prev.length > 0 && isTailChange(prev, next, bar);
    if (tail) {
      this.bars = next;
      this.pendingDraw.set(bar.t, bar);
    } else {
      this.withDataGuard(() => {
        this.setBars(next);
        if (prev.length === 0) this.fitInitialRange();
      });
    }
    this.indicators.advance(h, bar, kind);
    if (tail && prevRealtimeSeen === this.realtimeSeen && prevStalledAt === this.stalledAt) {
      this.requestTailLegendSources(next.length - 1);
    } else {
      this.requestLegendSources("base", "indicators", "compare");
    }
    this.refreshReady();
  }

  private onConnection(c: Connection): void {
    const previousStalledAt = this.stalledAt;
    const live = c.socket === "open" && c.status.realtime === "live";
    if (this.realtimeLive && !live && this.stalledAt === null) this.stalledAt = this.lastRealtimeAt ?? nowSeconds();
    this.realtimeLive = live;
    if (previousStalledAt !== this.stalledAt) this.requestLegendSources("base");
    this.scheduleFrame();
  }

  private active = true;
  private dirtyWhileInactive = false;
  private reportedCorner = { width: 0, height: 0 };

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.legend.setActive(active);
    this.indicators.setActive(active);
    if (!active) {
      if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
        this.dirtyWhileInactive = true;
      }
      if (this.legendFrame !== null) {
        cancelAnimationFrame(this.legendFrame);
        this.legendFrame = null;
        this.dirtyWhileInactive = true;
      }
      this.stopMicroFeeds();
      return;
    }
    this.syncMicroFeeds();
    if (this.dirtyWhileInactive) {
      this.dirtyWhileInactive = false;
      this.scheduleFrame();
    }
  }
  private reportCorner(): void {
    const width = this.chart.priceScale("right").width();
    const height = this.chart.timeScale().height();
    if (width === this.reportedCorner.width && height === this.reportedCorner.height) return;
    this.reportedCorner = { width, height };
    this.onCorner?.(this.reportedCorner);
  }

  private scheduleFrame(): void {
    this.cancelLegendFrame();
    if (this.disposed) return;
    if (!this.active) {
      this.dirtyWhileInactive = true;
      return;
    }
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = null;
      this.drawFrame(time);
    });
  }

  private scheduleLegendPaint(): void {
    if (this.disposed) return;
    if (!this.active) {
      this.dirtyWhileInactive = true;
      return;
    }
    if (this.frame !== null || this.legendFrame !== null) return;
    this.legendFrame = requestAnimationFrame(() => {
      this.legendFrame = null;
      this.paintLegend();
    });
  }

  private cancelLegendFrame(): void {
    if (this.legendFrame === null) return;
    cancelAnimationFrame(this.legendFrame);
    this.legendFrame = null;
  }

  private drawFrame(time: number): void {
    this.flushPendingDraw();
    this.compare.flush(this.bars);
    this.indicators.flush();
    this.fitAxisWidth();
    if (this.axisLabels.refresh(time)) this.scheduleFrame();
    this.renderLegend();
    this.renderExtremes();
    this.crosshairMarker.refresh();
  }

  private fitAxisWidth(): void {
    const range = this.view && shownScale(this.view.settings) !== "percent" ? this.main.api.priceScale().getVisibleRange() : null;
    const maxPrice = range ? Math.max(Math.abs(range.from), Math.abs(range.to)) : Number.NaN;
    if (!Number.isFinite(maxPrice)) {
      this.lastAxisCeil = null;
      this.axisStep = AXIS_WIDTH;
      this.applyAxisWidth();
      return;
    }
    const ceil = Math.ceil(maxPrice);
    const fontSize = this.tokens.fontSize;
    if (ceil !== this.lastAxisCeil || fontSize !== this.lastAxisFontSize) {
      this.lastAxisCeil = ceil;
      this.lastAxisFontSize = fontSize;
      this.axisStep = priceAxisWidth(maxPrice, fontSize);
    }
    this.applyAxisWidth();
  }

  private renderExtremes(): void {
    const view = this.view;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const info = view?.settings.showExtremes && this.bars.length && range ? this.main.api.barsInLogicalRange(range) : null;
    const paneWidth = this.chart.timeScale().width();
    const xOf = (index: number) => this.chart.timeScale().timeToCoordinate(toChartTime(this.bars[index]!.t));
    const onScreen = (index: number) => { const x = xOf(index); return x !== null && x >= 0 && x <= paneWidth; };
    let first = Math.max(0, Math.floor(info?.barsBefore ?? 0));
    let lastIndex = Math.min(this.bars.length - 1, this.bars.length - 1 - Math.floor(info?.barsAfter ?? 0));
    while (info && first <= lastIndex && !onScreen(first)) first++;
    while (info && lastIndex >= first && !onScreen(lastIndex)) lastIndex--;
    const found = info && findExtremes(this.bars, first, lastIndex);
    const last = this.bars[lastIndex];
    const paneHeight = this.chart.panes()[0]?.getHeight() ?? 0;
    const obstacles: { left: number; top: number; right: number; bottom: number }[] = [];
    const badgeBox = this.badge.box(this.el);
    if (badgeBox) obstacles.push(badgeBox);
    if (found && last) {
      const firstX = xOf(first);
      const lastX = xOf(lastIndex);
      const barStep = lastIndex > first && firstX !== null && lastX !== null ? (lastX - firstX) / (lastIndex - first) : 12;
      const halfWidth = Math.max(2, Math.min(12, barStep * 0.36)) + 2;
      for (let i = first; i <= lastIndex; i++) {
        const bar = this.bars[i]!;
        const cx = xOf(i);
        const top = this.main.api.priceToCoordinate(bar.h);
        const bottom = this.main.api.priceToCoordinate(bar.l);
        if (cx === null || top === null || bottom === null) continue;
        obstacles.push({
          left: cx - halfWidth,
          right: cx + halfWidth,
          top: Math.min(top, bottom) - 2,
          bottom: Math.max(top, bottom) + 2,
        });
      }
    }
    const surface = { paneWidth, paneHeight, avoid: this.legend.avoid, obstacles };
    if (!view || !last || !found) return this.extremeTags.show(null, surface);
    const isIndex = isIndexCode(view.symbol);
    const tag = ({ index, price }: Extreme): ExtremeTag | null => {
      const x = xOf(index);
      const y = this.main.api.priceToCoordinate(price);
      if (x === null || y === null || y < 0 || y > paneHeight) return null;
      return { x, y, price: formatPrice(price, isIndex), change: extremeChange(price, last.c, view.settings.extremeBasis) };
    };
    this.extremeTags.show({ high: tag(found.high), low: tag(found.low) }, surface);
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

  private onReset(raw: History): void {
    this.rawHistory = raw;
    if (this.tickReplay !== null) return;
    this.pendingEnd = null;
    const h = this.deriveHistory(raw);
    this.history = h;
    this.hoverIndex = null;
    this.financialHoverTime = null;
    this.realtimeSeen = false;
    if (this.realtimeLive) this.stalledAt = null;
    const bars = displayBars(h);
    this.withDataGuard(() => {
      this.setBars(bars);
      this.indicators.reset(h);
      if (bars.length > 0) this.fitInitialRange();
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
    } else if (this.regularFilterActive() && h.nextBefore !== null) {
      this.ready = null;
      this.onStatus({ kind: "loading" });
      this.feed.needOlder();
    } else {
      this.ready = null;
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
  }

  private fitInitialRange(): IRange<number> | null {
    return this.initialRange.fit({ bars: this.bars, period: this.period(), visibleBars: this.view?.settings.visibleBars ?? null, narrow: this.narrow, rightOffset: this.rightOffset() });
  }

  private rightEdgeT(): UnixSeconds | null {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    if (!r || this.bars.length === 0) return null;
    return chartTimeProjection(this.chart.timeScale(), this.period()).toTime(Math.floor(r.to + 0.5 + 1e-6));
  }

  jumpAnchor(): JumpAnchor | null {
    return jumpAnchor(barAtRightEdge(this.bars, this.rightEdgeT()), this.period());
  }

  async jumpTo(request: JumpRequest): Promise<JumpOutcome> {
    const view = this.view;
    if (!view || this.disposed) return "cancelled";
    const token = ++this.jumpToken;
    this.feed.cancelEntering();
    const today = kstDateOf(nowSeconds());
    const modeDate = this.feed.activeDate;
    const held = jumpHeld({ bars: this.bars, interval: request.interval, date: request.date, modeDate });
    const route = jumpRoute({ period: view.period, date: request.date, today, held });
    if (route === "mode") {
      const pending = { date: request.date, interval: request.interval };
      this.enteringJump = pending;
      const entry = await this.feed.enterMode(request.date);
      if (entry !== "entered") {
        if (this.enteringJump === pending) this.enteringJump = null;
        return entry;
      }
      if (token !== this.jumpToken) return "cancelled";
      if (this.regularFilterActive() && lastBarBefore(this.bars, request.interval) === null) {
        const reached = await this.feed.olderUntil((h) => lastBarBefore(displayBars(this.deriveHistory(h)), request.interval) !== null);
        if (reached === "stale" || token !== this.jumpToken) return "cancelled";
        if (reached === "failed" && this.bars.length === 0) return "failed";
      }
      return this.endingOutcome(request.interval);
    }
    if (route === "view" && request.date >= today && modeDate !== null) {
      this.feed.endMode();
      return "moved";
    }
    const reaches = route === "extend" ? (bars: readonly Bar[]) => lastBarBefore(bars, request.interval) !== null : request.date >= today ? (bars: readonly Bar[]) => (bars[0]?.t ?? Infinity) <= request.interval.start : null;
    if (reaches) {
      const reached = await this.feed.olderUntil((h) => reaches(displayBars(this.deriveHistory(h))));
      if (reached === "stale" || token !== this.jumpToken) return "cancelled";
      if (route === "extend" && lastBarBefore(this.bars, request.interval) === null) return reached === "failed" ? "failed" : "empty";
    }
    const outcome = this.endingOutcome(request.interval);
    if (outcome === "empty") return outcome;
    const end = lastBarBefore(this.bars, request.interval);
    if (end) this.fitEndingAt(this.bars[end.index]!.t);
    return outcome;
  }

  private endingOutcome(interval: BarInterval): JumpOutcome {
    const end = lastBarBefore(this.bars, interval);
    return end === null ? "empty" : end.inInterval ? "moved" : "previous";
  }

  private onJumpEntered(raw: History): void {
    this.rawHistory = raw;
    if (this.tickReplay !== null) return;
    if (this.enteringJump !== null && this.enteringJump.date === this.feed.activeDate && this.feed.mode?.entering !== true) {
      this.jumpInterval = this.enteringJump.interval;
      this.enteringJump = null;
    }
    this.pendingEnd = null;
    this.initialRange.release();
    this.rawHistory = raw;
    const h = this.deriveHistory(raw);
    this.history = h;
    this.hoverIndex = null;
    this.financialHoverTime = null;
    this.realtimeSeen = false;
    this.stalledAt = null;
    this.syncMicroFeeds();
    const bars = displayBars(h);
    this.withDataGuard(() => {
      this.setBars(bars);
      this.indicators.reset(h);
    });
    const latest = bars[bars.length - 1];
    if (latest) {
      const end = this.jumpInterval ? lastBarBefore(bars, this.jumpInterval) : null;
      if (end === null && this.jumpInterval !== null && h.nextBefore !== null) {
        this.ready = null;
        this.extendingJump = true;
        this.onStatus({ kind: "loading" });
        this.renderBadge();
        void this.extendJumpToInterval(this.jumpInterval, this.jumpToken);
      } else {
        this.ready = { kind: "ready", latest, prev: bars[bars.length - 2] ?? null, isCurrent: false, olderError: null, olderLoading: false, intradayEnd: false };
        this.onStatus(this.ready);
        if (end) this.fitEndingAt(bars[end.index]!.t);
        else this.fitInitialRange();
      }
    } else if (this.regularFilterActive() && h.nextBefore !== null) {
      this.ready = null;
      this.onStatus({ kind: "loading" });
      this.feed.needOlder();
    } else {
      this.ready = null;
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
    this.compare.coverFrom(this.leftT());
    this.renderLegend();
    this.updateIntradayEnd();
  }

  private async extendJumpToInterval(target: BarInterval, token: number): Promise<void> {
    let pages = 0;
    try {
      const reached = await this.feed.olderUntil((history) => {
        if (lastBarBefore(displayBars(this.deriveHistory(history)), target) !== null) return true;
        pages += 1;
        return pages >= MAX_JUMP_PRESERVE_PAGES;
      });
      if (this.disposed || token !== this.jumpToken || reached === "stale" || this.feed.activeDate === null) return;
      const latest = this.bars[this.bars.length - 1];
      if (!latest) return;
      this.ready = { kind: "ready", latest, prev: this.bars[this.bars.length - 2] ?? null, isCurrent: false, olderError: null, olderLoading: false, intradayEnd: false };
      this.onStatus(this.ready);
      const end = lastBarBefore(this.bars, target);
      if (end) this.fitEndingAt(this.bars[end.index]!.t);
      else this.fitInitialRange();
      this.compare.coverFrom(this.leftT());
      this.renderLegend();
      this.updateIntradayEnd();
    } finally {
      if (token === this.jumpToken) {
        this.extendingJump = false;
        this.renderBadge();
      }
    }
  }

  private onModeChanged(): void {
    if (this.feed.mode === null) {
      this.jumpInterval = null;
      this.enteringJump = null;
      this.extendingJump = false;
    }
    this.syncCompare();
    this.syncMicroFeeds();
    this.renderBadge();
  }

  private stopMicroFeeds(): void {
    this.tradeFeedSub?.stop();
    this.tradeFeedSub = null;
    this.programFeedSub?.stop();
    this.programFeedSub = null;
  }

  private syncMicroFeeds(): void {
    const view = this.view;
    const socket = this.socket;
    const liveAllowed = this.feed.activeDate === null && this.tickReplay === null;
    this.indicators.setMicroLive(liveAllowed);
    const eligible = this.active && liveAllowed && view !== null && socket !== undefined && !isIndexCode(view.symbol) && isIntraday(view.period);
    const wantTrades = eligible && view.settings.indicators.some(
      (c) => c.visible && (isTickCvd(c.spec) || (isProgramFlow(c.spec) && c.spec.showShare)),
    );
    const wantProgram = eligible && view.settings.indicators.some((c) => isProgramFlow(c.spec) && c.visible);

    if (!wantTrades) {
      this.tradeFeedSub?.stop();
      this.tradeFeedSub = null;
    } else if (!this.tradeFeedSub || this.tradeFeedSub.symbol !== view.symbol || this.tradeFeedSub.venue !== view.venue) {
      this.tradeFeedSub?.stop();
      const symbol = view.symbol;
      const venue = view.venue;
      const stop = socket.subscribeFeed({ symbol, kind: "trades", venue: venue ?? "combined" }, (m) => {
        if (this.disposed || m.type !== "feed_trades") return;
        this.indicators.applyLiveTrades(symbol, m.trades);
      });
      this.tradeFeedSub = { symbol, venue, stop };
    }

    if (!wantProgram) {
      this.programFeedSub?.stop();
      this.programFeedSub = null;
    } else if (!this.programFeedSub || this.programFeedSub.symbol !== view.symbol) {
      this.programFeedSub?.stop();
      const symbol = view.symbol;
      const stop = socket.subscribeFeed({ symbol, kind: "program" }, (m) => {
        if (this.disposed || m.type !== "feed_program") return;
        this.indicators.applyLiveProgram(symbol, m.row);
      });
      this.programFeedSub = { symbol, stop };
    }
  }

  private syncCompare(): void {
    const view = this.view;
    if (!view) return;
    const shown = this.feed.activeDate === null && this.tickReplay === null ? compareEntries(view) : [];
    this.compare.setCodes(shown, { period: view.period, venueFor: (code) => compareVenue(code, view) });
  }

  private renderBadge(): void {
    const mode = this.feed.mode;
    const view = this.view;
    const visible = mode !== null && view !== null;
    const toggled = this.el.hasAttribute("data-jump-active") !== visible;
    this.el.toggleAttribute("data-jump-active", visible);
    if (!visible) {
      this.badge.show(null);
    } else {
      this.badge.show({
        date: mode.date,
        receiving: mode.entering || this.extendingJump || this.ready?.olderLoading === true,
        unadjustedDays: mode.unadjustedDays,
        compareHidden: this.feed.activeDate !== null && compareEntries(view).length > 0,
      });
    }
    if (toggled) {
      this.legend.fit("content");
      this.scheduleFrame();
    }
  }

  private fitEndingAt(endT: UnixSeconds): void {
    this.pendingEnd = endT;
    this.flushPendingEnd();
  }

  private flushPendingEnd(): void {
    const endT = this.pendingEnd;
    if (endT === null || this.disposed || this.el.clientWidth === 0 || this.el.clientHeight === 0) return;
    this.pendingEnd = null;
    const shown = barIndexAfter(this.bars, endT);
    this.initialRange.fit({
      bars: shown === -1 ? this.bars : this.bars.slice(0, shown),
      period: this.period(),
      visibleBars: this.view?.settings.visibleBars ?? null,
      narrow: this.narrow,
      rightOffset: shown === -1 ? this.rightOffset() : 0,
    });
  }

  private onPrepended(raw: History, added: number): void {
    this.rawHistory = raw;
    if (this.tickReplay !== null) return;
    const wasLoadingEmpty = this.ready === null && this.bars.length === 0;
    const prevLen = this.bars.length;
    const h = this.deriveHistory(raw);
    this.history = h;
    const bars = displayBars(h);
    if (wasLoadingEmpty) {
      const latest = bars[bars.length - 1];
      if (latest) {
        this.withDataGuard(() => {
          this.setBars(bars);
          this.indicators.reset(h);
          this.fitInitialRange();
        });
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
        if (this.feed.activeDate !== null && this.jumpInterval) {
          const end = lastBarBefore(bars, this.jumpInterval);
          if (end) this.fitEndingAt(bars[end.index]!.t);
        }
        this.compare.coverFrom(this.leftT());
        this.renderLegend();
        this.updateIntradayEnd();
      } else if (added > 0 && h.nextBefore !== null) {
        this.feed.needOlder();
      } else {
        this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
      }
      return;
    }
    this.patchReady({ olderLoading: false });
    if (added === 0) return this.updateIntradayEnd();
    if (bars.length === prevLen) {
      this.updateIntradayEnd();
      if (h.nextBefore !== null) {
        const left = this.leftT();
        const before = left === null ? -1 : barIndexAtOrAfter(this.bars, left);
        if (before >= 0 && before < LOAD_OLDER_WITHIN) this.feed.needOlder();
      }
      return;
    }
    this.withDataGuard(() => preserveTimeRange(this.chart.timeScale(), this.period(), this.pendingScroll, () => {
      this.setBars(bars);
      this.indicators.prepend(h);
    }));
    if (this.financialHoverTime !== null) this.hoverIndex = barIndexAt(this.bars, this.financialHoverTime);
    this.compare.coverFrom(this.leftT());
    this.renderLegend();
    this.updateIntradayEnd();
  }

  private patchReady(patch: Partial<Pick<ReadyStatus, "olderError" | "olderLoading" | "intradayEnd">>): void {
    if (!this.ready) return;
    this.ready = { ...this.ready, ...patch };
    this.onStatus(this.ready);
    this.renderBadge();
  }

  private updateIntradayEnd(): void {
    if (!this.ready || !this.view) return;
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const end = isIntraday(this.view.period) && this.history?.nextBefore === null && r !== null && r.from < 0.5;
    if (end !== this.ready.intradayEnd) this.patchReady({ intradayEnd: end });
  }

  private onFailed(error: ApiRequestError, clearRaw = true): void {
    if (this.tickReplay !== null) return;
    this.initialRange.release();
    this.ready = null;
    if (clearRaw) this.rawHistory = null;
    this.history = null;
    this.setBars([]);
    this.indicators.clear();
    this.renderLegend();
    this.onStatus({ kind: "error", error });
  }

  private paneBounds(): PaneBounds[] {
    const top = this.el.getBoundingClientRect().top;
    return this.chart.panes().map((p) => ({ top: (p.getHTMLElement()?.getBoundingClientRect().top ?? top) - top, height: p.getHeight() }));
  }

  /** Lightweight Charts는 % 축의 0%를 `floor(보이는 논리 범위 왼쪽)` 자리의 봉으로 잡는다. */
  private leftT(): UnixSeconds | null {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    const n = this.bars.length;
    if (!r || n === 0) return null;
    return chartTimeProjection(this.chart.timeScale(), this.period()).toTime(Math.max(0, Math.floor(r.from)));
  }

  private requestLegendSources(...sources: ("base" | "indicators" | "compare")[]): void {
    for (const source of sources) {
      if (source === "base") this.pendingBase = "full";
      else this.pendingLegendSources.add(source);
      if (source === "indicators") this.indicatorRowsDirty = true;
    }
    this.scheduleFrame();
  }

  private requestTailLegendSources(from: number): void {
    if (this.pendingBase !== "full") {
      this.pendingBase = this.pendingBase === null ? from : Math.min(this.pendingBase, from);
    }
    this.pendingLegendSources.add("indicators");
    this.indicatorRowsDirty = true;
    this.pendingLegendSources.add("compare");
    this.scheduleFrame();
  }

  private legendBarAt(view: CellView, index: number): LegendBar {
    const bar = this.bars[index]!;
    return {
      bar,
      prev: this.bars[index - 1] ?? null,
      isCurrent: this.history?.current?.t === bar.t && !this.realtimeSeen,
      isIndex: isIndexCode(view.symbol),
      period: view.period,
      stalledAt: this.stalledAt,
    };
  }

  private refreshPendingLegendSources(): boolean {
    const left = this.leftT();
    const view = this.view;
    const compareLeftChanged = left !== this.legendLeftT && Boolean(view && compareEntries(view).length > 0);
    if (compareLeftChanged) this.pendingLegendSources.add("compare");
    this.legendLeftT = left;
    let changed = false;
    const base = this.pendingBase;
    this.pendingBase = null;
    if (base === "full") {
      this.legend.setLayoutBars(view ? this.bars.map((_, i) => this.legendBarAt(view, i)) : []);
      changed = true;
    } else if (base !== null) {
      if (!view || this.bars.length === 0) {
        this.legend.setLayoutBars([]);
        changed = true;
      } else {
        const tail: LegendBar[] = [];
        for (let i = base; i < this.bars.length; i++) tail.push(this.legendBarAt(view, i));
        if (this.legend.updateLayoutTail(base, tail)) changed = true;
      }
    }
    if (this.pendingLegendSources.has("indicators")) {
      if (this.indicatorLegend.setLayoutRows(this.indicators.rows(this.bars.at(-1)?.t ?? null), this.indicators.priceLegendValues())) changed = true;
    }
    if (this.pendingLegendSources.has("compare")) {
      if (this.compareLegend.setLayoutRows(this.compare.rows(left, null), this.compare.legendValues(left)) || compareLeftChanged) changed = true;
    }
    this.pendingLegendSources.clear();
    return changed;
  }

  private paneHeightsChanged(chartPanes: ReturnType<IChartApi["panes"]>): boolean {
    if (chartPanes.length !== this.lastPaneHeights.length) return true;
    for (let i = 0; i < chartPanes.length; i++) {
      if (chartPanes[i]!.getHeight() !== this.lastPaneHeights[i]) return true;
    }
    return false;
  }

  private syncPaneLayout(): boolean {
    const axisWidth = this.chart.priceScale("right").width();
    const leftAxisWidth = this.leftAxisWidth();
    const chartPanes = this.chart.panes();
    if (!this.paneLayoutDirty && axisWidth === this.lastAxisWidth && leftAxisWidth === this.lastLeftAxisWidth && !this.paneHeightsChanged(chartPanes)) return false;
    this.paneLayoutDirty = false;
    this.lastAxisWidth = axisWidth;
    this.lastLeftAxisWidth = leftAxisWidth;
    this.lastPaneHeights = chartPanes.map((pane) => pane.getHeight());
    const panes = this.paneBounds();
    const view = this.view;
    const panels = view ? chartPanels(view.settings, this.period(), !isIndexCode(view.symbol)) : [];
    this.panelControls.render(panels, panes.map((pane) => pane.top));
    this.legend.setLeftAxisWidth(leftAxisWidth);
    this.pendingPaneLayout = { panes, axisWidth, leftAxisWidth };
    return true;
  }

  private renderLegend(): void {
    this.compare.flush(this.bars);
    this.indicators.flush();
    const sourcesChanged = this.refreshPendingLegendSources();
    const layoutUpdated = this.syncPaneLayout();
    this.paintLegend();
    if (sourcesChanged) this.legend.fit("content");
    else if (layoutUpdated) this.legend.fit("geometry");
  }

  private paintLegend(): void {
    this.cancelLegendFrame();
    const view = this.view;
    const i = this.hoverIndex ?? this.bars.length - 1;
    const bar = this.bars[i];
    const rowTime = this.financialHoverTime ?? bar?.t ?? null;
    const paneLayout = this.pendingPaneLayout;
    this.pendingPaneLayout = null;
    if (paneLayout) {
      this.indicatorRowsDirty = false;
      this.lastIndicatorRowTime = rowTime;
      this.indicatorLegend.render(this.indicators.rows(rowTime), paneLayout.panes, paneLayout.axisWidth, paneLayout.leftAxisWidth);
    } else if (this.indicatorRowsDirty || rowTime !== this.lastIndicatorRowTime) {
      this.indicatorRowsDirty = false;
      this.lastIndicatorRowTime = rowTime;
      this.indicatorLegend.render(this.indicators.rows(rowTime), null, undefined, this.lastLeftAxisWidth);
    }
    const compareLeft = view?.settings.compare.length ? this.leftT() : null;
    this.compareLegend.render(this.compare.rows(compareLeft, bar?.t ?? null));
    if (!view || !bar) this.legend.show(null);
    else this.legend.show({
      bar,
      prev: this.bars[i - 1] ?? null,
      isCurrent: this.history?.current?.t === bar.t && !this.realtimeSeen,
      isIndex: isIndexCode(view.symbol),
      period: view.period,
      stalledAt: this.stalledAt,
    }, this.hoverIndex !== null);
  }
}

function compareEntries(view: CellView): CompareEntry[] {
  return view.settings.compare.flatMap((code, i) =>
    code === view.symbol ? [] : [{ code, slot: (i + 1) as CompareEntry["slot"], name: view.compareNames?.[code] ?? code }],
  );
}
