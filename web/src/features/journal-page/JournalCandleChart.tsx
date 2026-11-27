import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
  type MouseEventParams,
  type TickMarkType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { fetchBarsPage, fetchJumpPage } from "../../api/bars";
import type { Bar } from "../../api/generated/Bar";
import type { Period } from "../../api/generated/Period";
import type { Venue } from "../../api/generated/Venue";
import { axisPriceFormat } from "../../chart/axisFormat";
import { displayBars, type History } from "../../chart/barFeed";
import { DaySeparators } from "../../chart/daySeparators";
import { JumpableFeed } from "../../chart/jumpFeed";
import { readThemeTokens, type ThemeTokens } from "../../chart/theme";
import { formatBarTime, formatTickMark, fromChartTime, isIntraday, toChartTime } from "../../chart/time";
import { PendingScroll } from "../../chart/timeAxis";
import { subscribeTheme } from "../../persist/theme";
import { findBarIndexForFill, JournalTradeOverlay } from "./journalChartOverlay";
import {
  dayShortLabel,
  formatMinutes,
  formatPct,
  formatUtcMsToDay,
  formatWon,
  synthesizeDemoBars,
  toneClass,
} from "./journalEngine";
import { JOURNAL_TFS, TF_TO_PERIOD, type JournalBar, type JournalFill, type JournalTf, type JournalTrade } from "./journalTypes";

const LOAD_OLDER_WITHIN = 50;
const MAX_INITIAL_OLDER_PAGES = 10;
const RIGHT_OFFSET_BARS = 12;

interface Props {
  readonly trade: JournalTrade;
  readonly tf: JournalTf;
  readonly today: string;
  readonly isAutoTf: boolean;
  readonly afterCost: boolean;
  readonly highlightFill: JournalFill | null;
  readonly resetTick: number;
}

interface LegendState {
  readonly dateLabel: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly chgPct: number;
  readonly fillNote: string;
}

function toJournalBars(bars: readonly Bar[]): readonly JournalBar[] {
  return bars.map((b) => {
    const kstMs = b.t * 1000 + 9 * 3600_000;
    const dt = new Date(kstMs);
    const day = formatUtcMsToDay(kstMs);
    const minutes = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, day, minutes };
  });
}

function findBarIndexByTime(bars: readonly JournalBar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midT = bars[mid]!.t;
    if (midT === t) return mid;
    if (midT < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function buildLegendState(bar: JournalBar, trade: JournalTrade, tf: JournalTf, bars: readonly JournalBar[], idx: number): LegendState {
  const chgPct = bar.o > 0 ? ((bar.c - bar.o) / bar.o) * 100 : 0;
  const dateLabel = tf === "D" ? dayShortLabel(bar.day) : `${dayShortLabel(bar.day)} ${formatMinutes(bar.minutes)}`;
  const hereB = trade.buys.filter((f) => findBarIndexForFill(bars, f, tf) === idx);
  const hereS = trade.sells.filter((f) => findBarIndexForFill(bars, f, tf) === idx);
  const notes: string[] = [];
  if (hereB.length > 0) notes.push(`▲ 매수 ${hereB.map((f) => `${formatWon(f.price, false)}×${f.qty}`).join(", ")}`);
  if (hereS.length > 0) notes.push(`▼ 매도 ${hereS.map((f) => `${formatWon(f.price, false)}×${f.qty}`).join(", ")}`);
  return { dateLabel, o: bar.o, h: bar.h, l: bar.l, c: bar.c, chgPct, fillNote: notes.join("  ") };
}

function chartOptionsOf(tokens: ThemeTokens, period: Period) {
  const crossLine = { color: tokens.crosshair, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: tokens.raised };
  return {
    layout: {
      background: { color: tokens.chartBg || tokens.raised },
      textColor: tokens.text2,
      fontFamily: tokens.fontFamily,
      fontSize: tokens.fontSize,
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: true, color: tokens.grid },
      horzLines: { visible: true, color: tokens.gridH },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: crossLine,
      horzLine: crossLine,
    },
    rightPriceScale: {
      minimumWidth: 68,
      alignLabels: true,
      entireTextOnly: true,
      borderColor: tokens.line,
      scaleMargins: { top: 0.14, bottom: 0.22 },
    },
    timeScale: {
      borderColor: tokens.line,
      rightOffset: RIGHT_OFFSET_BARS,
      fixLeftEdge: false,
      fixRightEdge: false,
      timeVisible: isIntraday(period),
      secondsVisible: false,
      tickMarkFormatter: (time: Time, type: TickMarkType) => formatTickMark(time as UTCTimestamp, type, period),
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true,
    },
    handleScale: {
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
      mouseWheel: true,
      pinch: true,
    },
    localization: {
      locale: "ko-KR",
      timeFormatter: (time: Time) => formatBarTime(fromChartTime(time as UTCTimestamp), period),
    },
  };
}

interface ChartNotice {
  readonly kind: "empty" | "error";
  readonly message: string;
}

function computeTradeFocusRange(bars: readonly JournalBar[], trade: JournalTrade, tf: JournalTf): { from: number; to: number } {
  const n = bars.length;
  if (n === 0) return { from: 0, to: 1 };
  const firstBuy = trade.buys[0];
  const lastSell = trade.sells[trade.sells.length - 1];
  const rawEntry = firstBuy ? findBarIndexForFill(bars, firstBuy, tf) : -1;
  const rawExit = lastSell ? findBarIndexForFill(bars, lastSell, tf) : -1;
  const entryIdx = rawEntry >= 0 ? rawEntry : rawExit >= 0 ? rawExit : 0;
  const exitIdx = rawExit >= 0 ? rawExit : rawEntry >= 0 ? rawEntry : n - 1;
  const lo = Math.max(0, Math.min(entryIdx, exitIdx));
  const hi = Math.max(0, Math.max(entryIdx, exitIdx));
  if (tf === "D") {
    const pad = Math.max(18, Math.round((hi - lo) * 0.8));
    return { from: lo - pad, to: hi + Math.max(10, Math.round(pad * 0.4)) };
  }
  const span = hi - lo;
  const pad = Math.max(20, Math.round(span * 0.6));
  let from = lo - pad;
  let to = hi + pad + 1;
  if (to - from < 60) {
    const mid = (from + to) / 2;
    from = mid - 30;
    to = mid + 30;
  }
  return { from, to };
}

export function JournalCandleChart({ trade, tf, today, isAutoTf, afterCost, highlightFill, resetTick }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRef = useRef<JournalTradeOverlay | null>(null);
  const daySepsRef = useRef<DaySeparators | null>(null);
  const feedRef = useRef<JumpableFeed | null>(null);
  const pendingScrollRef = useRef<PendingScroll | null>(null);
  const barsRef = useRef<readonly JournalBar[]>([]);
  const settingDataRef = useRef(false);
  const tokensRef = useRef<ThemeTokens>(readThemeTokens());

  const propsRef = useRef({ trade, tf, today, afterCost, highlightFill });
  propsRef.current = { trade, tf, today, afterCost, highlightFill };

  const [legend, setLegend] = useState<LegendState | null>(null);
  const [chartNotice, setChartNotice] = useState<ChartNotice | null>(null);
  const [olderError, setOlderError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const period = TF_TO_PERIOD[tf];
  const venueParam: Venue = trade.venue;
  const isDemo = trade.demoSeed !== null;

  const updateLegendForIndex = (idx: number) => {
    const bars = barsRef.current;
    if (bars.length === 0) return;
    const clamped = Math.max(0, Math.min(bars.length - 1, idx));
    const bar = bars[clamped]!;
    const { trade: curTrade, tf: curTf } = propsRef.current;
    setLegend(buildLegendState(bar, curTrade, curTf, bars, clamped));
  };

  const clearChartData = () => {
    const candle = candleRef.current;
    const volume = volumeRef.current;
    const overlay = overlayRef.current;
    barsRef.current = [];
    if (candle && volume) {
      settingDataRef.current = true;
      try {
        candle.setData([]);
        volume.setData([]);
      } finally {
        settingDataRef.current = false;
      }
    }
    if (overlay) {
      const { trade: curTrade, tf: curTf, afterCost: curAfterCost, highlightFill: curHighlight } = propsRef.current;
      overlay.setState({ trade: curTrade, tf: curTf, bars: [], afterCost: curAfterCost, highlightFill: curHighlight });
    }
    daySepsRef.current?.sync();
    setLegend(null);
    const box = boxRef.current;
    if (box) {
      box.dataset.barCount = "0";
      box.dataset.firstBarT = "";
      box.dataset.lastBarT = "";
    }
  };

  const applyBars = (bars: readonly JournalBar[], shiftLogicalBy: number | null) => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const volume = volumeRef.current;
    const overlay = overlayRef.current;
    if (!chart || !candle || !volume || !overlay) return;

    const prevRange = shiftLogicalBy !== null ? chart.timeScale().getVisibleLogicalRange() : null;
    barsRef.current = bars;
    const tokens = tokensRef.current;

    settingDataRef.current = true;
    try {
      candle.setData(
        bars.map((b) => ({
          time: toChartTime(b.t),
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
        })),
      );
      volume.setData(
        bars.map((b) => ({
          time: toChartTime(b.t),
          value: b.v,
          color: b.c >= b.o ? tokens.upVol : tokens.downVol,
        })),
      );
      if (prevRange !== null && shiftLogicalBy !== null && shiftLogicalBy > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: prevRange.from + shiftLogicalBy,
          to: prevRange.to + shiftLogicalBy,
        });
      }
    } finally {
      settingDataRef.current = false;
    }

    const { trade: curTrade, tf: curTf, afterCost: curAfterCost, highlightFill: curHighlight } = propsRef.current;
    overlay.setState({ trade: curTrade, tf: curTf, bars, afterCost: curAfterCost, highlightFill: curHighlight });
    daySepsRef.current?.sync();

    const box = boxRef.current;
    if (box) {
      box.dataset.barCount = String(bars.length);
      box.dataset.firstBarT = String(bars[0]?.t ?? "");
      box.dataset.lastBarT = String(bars[bars.length - 1]?.t ?? "");
    }

    if (shiftLogicalBy === null && bars.length > 0) {
      const focus = computeTradeFocusRange(bars, curTrade, curTf);
      chart.timeScale().setVisibleLogicalRange(focus);
      const lastSell = curTrade.sells[curTrade.sells.length - 1];
      const idx = lastSell ? findBarIndexForFill(bars, lastSell, curTf) : bars.length - 1;
      updateLegendForIndex(idx >= 0 ? idx : bars.length - 1);
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tokens = readThemeTokens();
    tokensRef.current = tokens;
    const initialPeriod = TF_TO_PERIOD[propsRef.current.tf];
    const chart = createChart(host, { ...chartOptionsOf(tokens, initialPeriod), autoSize: true });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      priceFormat: axisPriceFormat("price", 1),
      lastValueVisible: false,
      priceLineVisible: false,
      upColor: tokens.up,
      downColor: tokens.down,
      borderUpColor: tokens.up,
      borderDownColor: tokens.down,
      wickUpColor: tokens.up,
      wickDownColor: tokens.down,
    });
    candleRef.current = candle;

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      visible: false,
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeRef.current = volume;

    const overlay = new JournalTradeOverlay();
    candle.attachPrimitive(overlay);
    overlayRef.current = overlay;

    const daySeps = new DaySeparators(chart, {
      shown: () => isIntraday(TF_TO_PERIOD[propsRef.current.tf]),
      bars: () => barsRef.current,
      color: () => tokensRef.current.daySeparator,
    });
    daySepsRef.current = daySeps;

    const pendingScroll = new PendingScroll((callback) => requestAnimationFrame(callback));
    pendingScrollRef.current = pendingScroll;

    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.deltaY === 0) return;
      const timeScale = chart.timeScale();
      const focused = event.ctrlKey || event.metaKey;
      if (event.shiftKey && !focused) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 32 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1;
        const shift = (event.deltaY * unit * 0.8) / Math.max(1, timeScale.options().barSpacing);
        pendingScroll.scrollByUser(timeScale, shift);
        return;
      }
      const rightBarStaysOnScroll = !focused;
      if (timeScale.options().rightBarStaysOnScroll !== rightBarStaysOnScroll) {
        timeScale.applyOptions({ rightBarStaysOnScroll });
      }
    };
    chart.chartElement().addEventListener("wheel", onWheel, { capture: true, passive: false });

    const onRangeChange = (range: { from: number; to: number } | null) => {
      if (boxRef.current && range !== null) {
        boxRef.current.dataset.visibleFrom = range.from.toFixed(1);
        boxRef.current.dataset.visibleTo = range.to.toFixed(1);
      }
      if (settingDataRef.current || range === null) return;
      if (range.from < LOAD_OLDER_WITHIN) {
        feedRef.current?.needOlder();
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const bars = barsRef.current;
      if (bars.length === 0) return;
      if (param.time !== undefined && typeof param.time === "number") {
        const unixT = fromChartTime(param.time as UTCTimestamp);
        const idx = findBarIndexByTime(bars, unixT);
        if (idx >= 0) {
          updateLegendForIndex(idx);
          return;
        }
      }
      const { trade: curTrade, tf: curTf } = propsRef.current;
      const lastSell = curTrade.sells[curTrade.sells.length - 1];
      const idx = lastSell ? findBarIndexForFill(bars, lastSell, curTf) : bars.length - 1;
      updateLegendForIndex(idx >= 0 ? idx : bars.length - 1);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const unsubTheme = subscribeTheme(() => {
      const nextTokens = readThemeTokens();
      tokensRef.current = nextTokens;
      chart.applyOptions(chartOptionsOf(nextTokens, TF_TO_PERIOD[propsRef.current.tf]));
      candle.applyOptions({
        upColor: nextTokens.up,
        downColor: nextTokens.down,
        borderUpColor: nextTokens.up,
        borderDownColor: nextTokens.down,
        wickUpColor: nextTokens.up,
        wickDownColor: nextTokens.down,
      });
      if (barsRef.current.length > 0) {
        volume.setData(
          barsRef.current.map((b) => ({
            time: toChartTime(b.t),
            value: b.v,
            color: b.c >= b.o ? nextTokens.upVol : nextTokens.downVol,
          })),
        );
      }
      overlay.refreshTheme();
      daySeps.sync();
    });

    return () => {
      unsubTheme();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      chart.chartElement().removeEventListener("wheel", onWheel, true);
      feedRef.current?.dispose();
      feedRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      overlayRef.current = null;
      daySepsRef.current = null;
      pendingScrollRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions(chartOptionsOf(tokensRef.current, period));
    feedRef.current?.dispose();
    feedRef.current = null;
    setChartNotice(null);
    setOlderError(false);

    if (isDemo) {
      applyBars(synthesizeDemoBars(trade, tf), null);
      return;
    }

    let disposed = false;
    let initialPages = 0;

    const loadOlderToEntry = (feed: JumpableFeed) => {
      void feed.olderUntil((h) => {
        initialPages += 1;
        const list = displayBars(h);
        if (list.length === 0 || initialPages >= MAX_INITIAL_OLDER_PAGES) return true;
        const firstDay = toJournalBars([list[0]!])[0]!.day;
        return firstDay <= trade.entryDay;
      }).then(() => {
        if (!disposed && chartRef.current && barsRef.current.length > 0) {
          chartRef.current.timeScale().setVisibleLogicalRange(
            computeTradeFocusRange(barsRef.current, propsRef.current.trade, propsRef.current.tf),
          );
        }
      });
    };

    const jumpToExitDay = (feed: JumpableFeed) => {
      void feed.enterMode(trade.exitDay).then((outcome) => {
        if (disposed || outcome === "entered" || outcome === "cancelled") return;
        clearChartData();
        setChartNotice({
          kind: outcome === "failed" ? "error" : "empty",
          message:
            outcome === "failed"
              ? `${trade.exitDay} 분봉을 불러오지 못했습니다`
              : `${trade.exitDay} 분봉 데이터가 없습니다`,
        });
      });
    };

    const handleHistory = (history: History, mode: "reset" | "prepended" | "jump", added = 0) => {
      if (disposed) return;
      const raw = displayBars(history);
      if (raw.length === 0) {
        if (mode === "reset" && tf !== "D" && trade.exitDay < today) {
          jumpToExitDay(feed);
          return;
        }
        if (mode === "reset" || mode === "jump") {
          clearChartData();
          setChartNotice({
            kind: "empty",
            message: mode === "jump" ? `${trade.exitDay} 분봉 데이터가 없습니다` : "봉 데이터가 없습니다",
          });
        }
        return;
      }
      const converted = toJournalBars(raw);
      if (mode === "prepended") {
        setOlderError(false);
        applyBars(converted, added);
        return;
      }
      const earliestDay = converted[0]!.day;
      if (mode === "reset" && tf !== "D" && trade.exitDay < earliestDay && trade.exitDay < today) {
        jumpToExitDay(feed);
        return;
      }
      setChartNotice(null);
      applyBars(converted, null);

      if (trade.entryDay < earliestDay && history.nextBefore !== null) {
        loadOlderToEntry(feed);
      }
    };

    const feed = new JumpableFeed(
      (q, signal) => fetchBarsPage(q, signal),
      (q, signal) => fetchJumpPage(q, signal),
      {
        reset: (history) => handleHistory(history, "reset"),
        jumpEntered: (history) => handleHistory(history, "jump"),
        prepended: (history, added) => handleHistory(history, "prepended", added),
        failed: () => {
          if (disposed) return;
          clearChartData();
          setChartNotice({ kind: "error", message: "봉 데이터를 불러오지 못했습니다" });
        },
        olderFailed: () => {
          if (!disposed) setOlderError(true);
        },
        live: () => {},
        confirmed: () => {},
        subError: () => {},
        modeChanged: () => {},
      },
    );
    feedRef.current = feed;
    feed.open({ symbol: trade.code, venue: venueParam, period });

    return () => {
      disposed = true;
      feed.dispose();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [trade.id, trade.code, trade.exitDay, trade.entryDay, venueParam, period, tf, isDemo, today, reloadTick]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || barsRef.current.length === 0) return;
    overlay.setState({ trade, tf, bars: barsRef.current, afterCost, highlightFill });
  }, [trade, tf, afterCost, highlightFill]);

  useEffect(() => {
    if (resetTick === 0 || !chartRef.current || barsRef.current.length === 0) return;
    chartRef.current.timeScale().setVisibleLogicalRange(computeTradeFocusRange(barsRef.current, trade, tf));
  }, [resetTick, trade, tf]);

  const tfName = JOURNAL_TFS.find((entry) => entry.tf === tf)?.label ?? tf;

  return (
    <div
      ref={boxRef}
      className="jrn-chart-box"
      data-testid="journal-candle-chart"
      data-tf={tf}
      data-period={period}
      onDoubleClick={() => {
        if (!chartRef.current || barsRef.current.length === 0) return;
        chartRef.current.timeScale().setVisibleLogicalRange(computeTradeFocusRange(barsRef.current, trade, tf));
      }}
    >
      <div ref={hostRef} className="jrn-chart-host" />
      {legend !== null && (
        <div className="jrn-chart-legend">
          <span>{`${tfName}${isAutoTf ? " (자동)" : ""}`}</span>
          <span className="jrn-mono">{legend.dateLabel}</span>
          <span>시<b>{formatWon(legend.o, false)}</b></span>
          <span>고<b className="jrn-up">{formatWon(legend.h, false)}</b></span>
          <span>저<b className="jrn-dn">{formatWon(legend.l, false)}</b></span>
          <span>종<b className={toneClass(legend.chgPct) ? `jrn-${toneClass(legend.chgPct)}` : ""}>{formatWon(legend.c, false)}</b></span>
          <span className={toneClass(legend.chgPct) ? `jrn-${toneClass(legend.chgPct)}` : ""}>{formatPct(legend.chgPct)}</span>
          {legend.fillNote !== "" && <span className="jrn-chart-fill-note">{legend.fillNote}</span>}
        </div>
      )}
      {olderError && chartNotice === null && (
        <div className="jrn-chart-older-banner" data-testid="journal-chart-older-error">
          <span>과거 봉을 더 불러오지 못했습니다</span>
          <button
            type="button"
            className="jrn-txt-btn"
            onClick={() => {
              setOlderError(false);
              feedRef.current?.retryOlder();
            }}
          >
            다시 시도
          </button>
        </div>
      )}
      {chartNotice !== null && (
        <div className="jrn-chart-notice" data-testid="journal-chart-notice" data-kind={chartNotice.kind}>
          <span>{chartNotice.message}</span>
          <button type="button" className="jrn-txt-btn" onClick={() => setReloadTick((v) => v + 1)}>
            다시 시도
          </button>
        </div>
      )}
    </div>
  );
}
