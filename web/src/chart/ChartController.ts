import {
  type ChartOptions,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
  PriceScaleMode,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchBarsPage } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { SubErrorCode } from "../api/generated/SubErrorCode";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { ApiRequestError } from "../api/http";
import type { Connection, MarketSocketLike } from "../api/socket";
import { isIndexCode, PERIOD_LABEL, symbolSub } from "../lib/symbol";
import { type ShownVenue, venueLabel } from "../lib/venue";
import { BarFeed, displayBars, type FetchPage, type History } from "./barFeed";
import { Legend, legendParts } from "./legend";
import {
  addMainSeries,
  addVolumeSeries,
  applyMainColors,
  type MainSeries,
  priceFormat,
  setMainData,
  setVolumeData,
  updateMainBar,
  updateVolumeBar,
} from "./series";
import type { ChartSettings } from "./settings";
import { composeSnapshot, snapshotFileName } from "./snapshot";
import type { ThemeTokens } from "./theme";
import { formatBarTime, formatTickMark, fromChartTime, isIntraday } from "./time";

/** 왼쪽 끝이 이 봉 수 안으로 들어오면 과거 페이지를 받는다(frontend.md §5.7). */
const LOAD_OLDER_WITHIN = 50;
const RIGHT_OFFSET = 6;
/** 체결마다 React를 다시 그리지 않도록 칸 상태(휴대폰 머리)는 이 간격보다 자주 알리지 않는다. */
const STATUS_INTERVAL_MS = 250;

const SUB_ERROR_TEXT: Record<SubErrorCode, string> = {
  realtime_limit: "실시간 한도 초과: 조회 값만 보입니다",
  kiwoom_unavailable: "키움 조회 실패: 잠시 뒤 다시 시도합니다",
  unknown_symbol: "실시간 시세가 없는 종목: 조회 값만 보입니다",
  bad_request: "실시간 구독 실패: 조회 값만 보입니다",
};

const nowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000);

/** next가 prev의 마지막 봉 하나만 바꾸거나 하나만 붙였는가. 그렇다면 `update()`로 그릴 수 있다. */
function isTailChange(prev: Bar[], next: Bar[], bar: Bar): boolean {
  if (next[next.length - 1] !== bar) return false;
  const kept = next.length - 1;
  if (kept !== prev.length && !(kept === prev.length - 1 && prev[kept]?.t === bar.t)) return false;
  return kept === 0 || next[kept - 1] === prev[kept - 1];
}

export interface CellView {
  symbol: SymbolCode;
  venue: ShownVenue | null;
  period: Period;
  settings: ChartSettings;
  info: SymbolInfo | undefined;
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
}

/** 칸 하나의 차트 엔진 래퍼(frontend.md §5.4). React 밖의 명령형 객체다. */
export class ChartController {
  private readonly el: HTMLElement;
  private readonly chart: IChartApi;
  private main: MainSeries;
  private readonly volume: ISeriesApi<"Histogram">;
  private readonly legend: Legend;
  private readonly feed: BarFeed;
  private readonly onStatus: (s: CellStatus) => void;
  private tokens: ThemeTokens;
  private view: CellView | null = null;
  private history: History | null = null;
  private bars: Bar[] = [];
  private hoverIndex: number | null = null;
  private ready: ReadyStatus | null = null;
  private settingData = false;
  private disposed = false;
  /** 다음 프레임에 `update()`로 그릴 봉. t 오름차순이고 같은 t는 마지막 값만 남는다. */
  private readonly pendingDraw = new Map<UnixSeconds, Bar>();
  private frame: number | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusAt = 0;
  /** 이 세대에 실시간 봉을 받았다. 받았으면 현재 봉은 더는 `조회 값`이 아니다. */
  private realtimeSeen = false;
  private realtimeLive = false;
  private lastRealtimeAt: UnixSeconds | null = null;
  private stalledAt: UnixSeconds | null = null;
  private readonly unwatch: () => void;

  constructor(el: HTMLElement, deps: ControllerDeps) {
    this.el = el;
    this.tokens = deps.tokens;
    this.onStatus = deps.onStatus;
    this.chart = createChart(el, { ...this.chartOptions(), autoSize: true });
    this.volume = addVolumeSeries(this.chart);
    this.main = addMainSeries(this.chart, "candle", this.tokens, false);
    this.legend = new Legend(el);
    this.feed = new BarFeed(
      deps.fetchPage ?? fetchBarsPage,
      {
        reset: (h) => this.onReset(h),
        prepended: (h, added) => this.onPrepended(h, added),
        failed: (e) => this.onFailed(e),
        olderFailed: (e) => this.patchReady({ olderError: e }),
        live: (h, bar) => this.onRealtime(h, bar),
        confirmed: (h, bar) => this.onRealtime(h, bar),
        subError: (code) => this.legend.setNotice(code === null ? null : SUB_ERROR_TEXT[code]),
      },
      deps.socket,
    );
    this.unwatch = deps.socket?.watch((c) => this.onConnection(c)) ?? (() => {});

    this.chart.subscribeCrosshairMove((p) => {
      const n = this.bars.length;
      this.hoverIndex =
        p.time !== undefined && p.logical !== undefined && n > 0 ? Math.min(n - 1, Math.max(0, Math.round(p.logical))) : null;
      this.renderLegend();
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (this.settingData) return;
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && r.from < LOAD_OLDER_WITHIN) this.feed.needOlder();
      this.updateIntradayEnd();
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
      venue: venueLabel(next.symbol, next.venue),
      period: PERIOD_LABEL[next.period],
    });

    if (prev?.settings.style !== next.settings.style) this.recreateMain(isIndex);
    if (prev?.settings.scale !== next.settings.scale) {
      this.chart.priceScale("right").applyOptions({
        mode: next.settings.scale === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      });
    }
    if (prev?.period !== next.period) this.chart.applyOptions({ timeScale: { timeVisible: isIntraday(next.period) } });
    if (prev?.symbol !== next.symbol || prev.venue !== next.venue || prev.period !== next.period) {
      if (prev && isIndexCode(prev.symbol) !== isIndex) this.main.api.applyOptions({ priceFormat: priceFormat(isIndex) });
      this.history = null;
      this.ready = null;
      this.legend.setNotice(null);
      this.setBars([]);
      this.renderLegend();
      this.onStatus({ kind: "loading" });
      this.feed.open({ symbol: next.symbol, venue: next.venue, period: next.period });
    }
  }

  /** 같은 봉 열을 처음부터 다시 받는다(오류 뒤 `다시 시도`). */
  reload(): void {
    if (!this.view) return;
    this.ready = null;
    this.onStatus({ kind: "loading" });
    this.feed.reload();
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
    };
    return {
      canvas: composeSnapshot(shot, head, this.tokens, shot.width / Math.max(1, this.el.clientWidth)),
      fileName: snapshotFileName(view.symbol, view.venue, view.period, takenAt),
    };
  }

  setTheme(tokens: ThemeTokens): void {
    this.tokens = tokens;
    this.chart.applyOptions(this.chartOptions());
    applyMainColors(this.main, tokens);
    setVolumeData(this.volume, this.bars, tokens);
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.unwatch();
    this.feed.dispose();
    this.legend.dispose();
    this.chart.remove();
  }

  private chartOptions(): DeepPartial<ChartOptions> {
    const t = this.tokens;
    const crossLine = { color: t.crosshair, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: t.raised };
    return {
      layout: {
        background: { color: t.chartBg },
        textColor: t.text2,
        fontFamily: t.fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: crossLine, horzLine: crossLine },
      rightPriceScale: { borderColor: t.line, scaleMargins: { top: 0.14, bottom: 0.22 } },
      timeScale: {
        borderColor: t.line,
        rightOffset: RIGHT_OFFSET,
        timeVisible: isIntraday(this.period()),
        secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatTickMark(time as UTCTimestamp, type, this.period()),
      },
      localization: {
        locale: "ko-KR",
        timeFormatter: (time: Time) => formatBarTime(fromChartTime(time as UTCTimestamp), this.period()),
      },
    };
  }

  private period(): Period {
    return this.view?.period ?? "D";
  }

  private recreateMain(isIndex: boolean): void {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.chart.removeSeries(this.main.api);
    this.main = addMainSeries(this.chart, this.view?.settings.style ?? "candle", this.tokens, isIndex);
    this.withDataGuard(() => {
      setMainData(this.main, this.bars);
      if (range) this.chart.timeScale().setVisibleLogicalRange(range);
    });
  }

  private setBars(bars: Bar[]): void {
    this.bars = bars;
    this.pendingDraw.clear();
    setMainData(this.main, bars);
    setVolumeData(this.volume, bars, this.tokens);
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

  /** 실시간 봉(현재 봉 갱신이나 확정). 상태는 바로 바꾸고 그리기는 다음 프레임에 묶는다(frontend.md §5.4). */
  private onRealtime(h: History, bar: Bar): void {
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
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.drawFrame();
    });
  }

  private drawFrame(): void {
    if (this.pendingDraw.size > 0) {
      this.withDataGuard(() => {
        for (const b of this.pendingDraw.values()) {
          updateMainBar(this.main, b);
          updateVolumeBar(this.volume, b, this.tokens);
        }
      });
      this.pendingDraw.clear();
      this.exposeBarsToE2e();
    }
    this.renderLegend();
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
    this.settingData = true;
    try {
      f();
    } finally {
      this.settingData = false;
    }
  }

  private onReset(h: History): void {
    this.history = h;
    this.hoverIndex = null;
    this.realtimeSeen = false;
    if (this.realtimeLive) this.stalledAt = null;
    const bars = displayBars(h);
    const show = matchMedia("(max-width: 767px)").matches ? 90 : 130;
    this.withDataGuard(() => {
      this.setBars(bars);
      this.chart.timeScale().setVisibleLogicalRange({ from: bars.length - show, to: bars.length - 1 + RIGHT_OFFSET });
    });
    this.renderLegend();
    const latest = bars[bars.length - 1];
    if (latest) {
      this.ready = {
        kind: "ready",
        latest,
        prev: bars[bars.length - 2] ?? null,
        isCurrent: h.current !== null && latest.t === h.current.t,
        olderError: null,
        intradayEnd: false,
      };
      this.onStatus(this.ready);
      this.updateIntradayEnd();
    } else {
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
  }

  private onPrepended(h: History, added: number): void {
    this.history = h;
    if (added === 0) return this.updateIntradayEnd();
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.withDataGuard(() => {
      this.setBars(displayBars(h));
      if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    });
    if (this.hoverIndex !== null) this.hoverIndex += added;
    this.renderLegend();
    this.updateIntradayEnd();
  }

  private patchReady(patch: Partial<Pick<ReadyStatus, "olderError" | "intradayEnd">>): void {
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
    this.renderLegend();
    this.onStatus({ kind: "error", error });
  }

  private renderLegend(): void {
    const view = this.view;
    const i = this.hoverIndex ?? this.bars.length - 1;
    const bar = this.bars[i];
    if (!view || !bar) return this.legend.show(null);
    this.legend.show({
      bar,
      prev: this.bars[i - 1] ?? null,
      isCurrent: this.history?.current?.t === bar.t && !this.realtimeSeen,
      isIndex: isIndexCode(view.symbol),
      period: view.period,
      stalledAt: this.stalledAt,
    });
  }
}
