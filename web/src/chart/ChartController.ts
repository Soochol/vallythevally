import {
  type ChartOptions,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
  PriceScaleMode,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchBarsPage } from "../api/bars";
import type { Bar } from "../api/generated/Bar";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import { ApiRequestError } from "../api/http";
import { isIndexCode, PERIOD_LABEL, symbolSub } from "../lib/symbol";
import { BarFeed, displayBars, type FetchPage, type History } from "./barFeed";
import { Legend } from "./legend";
import { addMainSeries, addVolumeSeries, applyMainColors, type MainSeries, priceFormat, setMainData, setVolumeData } from "./series";
import type { ChartSettings } from "./settings";
import type { ThemeTokens } from "./theme";
import { formatBarTime, fromChartTime } from "./time";

/** 왼쪽 끝이 이 봉 수 안으로 들어오면 과거 페이지를 받는다(frontend.md §5.7). */
const LOAD_OLDER_WITHIN = 50;
const RIGHT_OFFSET = 6;

export interface CellView {
  symbol: SymbolCode;
  period: Period;
  settings: ChartSettings;
  info: SymbolInfo | undefined;
}

/** React가 그리는 칸 상태: 불러오는 중, 오류, 또는 마지막 봉(휴대폰 머리용). */
export type CellStatus =
  | { kind: "loading" }
  | { kind: "ready"; latest: Bar; prev: Bar | null; isCurrent: boolean; fetchedAt: number; olderError: ApiRequestError | null }
  | { kind: "error"; error: ApiRequestError };

export interface ControllerDeps {
  tokens: ThemeTokens;
  onStatus: (s: CellStatus) => void;
  fetchPage?: FetchPage;
}

/** 칸 하나의 차트 엔진 래퍼(frontend.md §5.4). React 밖의 명령형 객체다. */
export class ChartController {
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
  private ready: Extract<CellStatus, { kind: "ready" }> | null = null;
  private settingData = false;
  private disposed = false;

  constructor(el: HTMLElement, deps: ControllerDeps) {
    this.tokens = deps.tokens;
    this.onStatus = deps.onStatus;
    this.chart = createChart(el, { ...this.chartOptions(), autoSize: true });
    this.volume = addVolumeSeries(this.chart);
    this.main = addMainSeries(this.chart, "candle", this.tokens, false);
    this.legend = new Legend(el);
    this.feed = new BarFeed(deps.fetchPage ?? fetchBarsPage, {
      reset: (h) => this.onReset(h),
      prepended: (h, added) => this.onPrepended(h, added),
      failed: (e) => this.onFailed(e),
      olderFailed: (e) => this.emitReady(e),
    });

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
    this.legend.setHead(next.info?.name ?? next.symbol, symbolSub(next.symbol, next.info), PERIOD_LABEL[next.period]);

    if (prev?.settings.style !== next.settings.style) this.recreateMain(isIndex);
    if (prev?.settings.scale !== next.settings.scale) {
      this.chart.priceScale("right").applyOptions({
        mode: next.settings.scale === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      });
    }
    if (prev?.symbol !== next.symbol || prev.period !== next.period) {
      if (prev && isIndexCode(prev.symbol) !== isIndex) this.main.api.applyOptions({ priceFormat: priceFormat(isIndex) });
      this.history = null;
      this.ready = null;
      this.setBars([]);
      this.renderLegend();
      this.onStatus({ kind: "loading" });
      this.feed.open(next.symbol, next.period);
    }
  }

  /** 같은 종목·봉 주기를 처음부터 다시 받는다(오류 뒤 `다시 시도`). */
  reload(): void {
    if (!this.view) return;
    this.ready = null;
    this.onStatus({ kind: "loading" });
    this.feed.reload();
  }

  /** 실패한 과거 페이지를 다시 받는다(과거 봉 오류의 `다시 시도`). */
  retryOlder(): void {
    this.emitReady(null);
    this.feed.retryOlder();
  }

  setTheme(tokens: ThemeTokens): void {
    this.tokens = tokens;
    this.chart.applyOptions(this.chartOptions());
    applyMainColors(this.main, tokens);
    setVolumeData(this.volume, this.bars, tokens);
  }

  dispose(): void {
    this.disposed = true;
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
      timeScale: { borderColor: t.line, rightOffset: RIGHT_OFFSET, timeVisible: false },
      localization: {
        locale: "ko-KR",
        timeFormatter: (time: Time) => formatBarTime(fromChartTime(time as UTCTimestamp), this.view?.period ?? "D"),
      },
    };
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
    setMainData(this.main, bars);
    setVolumeData(this.volume, bars, this.tokens);
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
        fetchedAt: Date.now(),
        olderError: null,
      };
      this.onStatus(this.ready);
    } else {
      this.onStatus({ kind: "error", error: new ApiRequestError("internal", "받은 봉이 없습니다") });
    }
  }

  private onPrepended(h: History, added: number): void {
    this.history = h;
    if (added === 0) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    this.withDataGuard(() => {
      this.setBars(displayBars(h));
      if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    });
    if (this.hoverIndex !== null) this.hoverIndex += added;
    this.renderLegend();
  }

  private emitReady(olderError: ApiRequestError | null): void {
    if (!this.ready) return;
    this.ready = { ...this.ready, olderError };
    this.onStatus(this.ready);
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
      isCurrent: this.history?.current?.t === bar.t,
      isIndex: isIndexCode(view.symbol),
      period: view.period,
    });
  }
}
