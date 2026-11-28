import { type PointerEvent, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../lib/format";
import { type CanvasPalette } from "./canvasTheme";
import {
  type AggregatedReplayBar,
  aggregateReplayBars,
  type ChartViewport,
  clampViewport,
  panViewport,
  REPLAY_CHART_TIMEFRAMES,
  type ReplayChartTimeframe,
  zoomViewport,
} from "./replayChartModel";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import {
  formatReplayHM,
  formatSignedQty,
  formatWonCompact,
  type ReplaySession,
} from "./replayModel";
import type { ReplayPaperEngine } from "./replayPaperEngine";

interface Props {
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly paper?: ReplayPaperEngine;
  readonly blindMode: boolean;
  readonly bookmarks: readonly number[];
  readonly palette: CanvasPalette;
  readonly onScrub: (sec: number) => void;
}

interface HoverPoint {
  readonly x: number;
  readonly y: number;
  readonly pane: "main" | "sub";
}

interface DragPanState {
  readonly startX: number;
  readonly startView: ChartViewport;
  readonly plotW: number;
  readonly totalBars: number;
  dragged: boolean;
}

const PAD_L = 8;
const PAD_R = 58;
const DRAG_THRESHOLD_PX = 5;

function prepareCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

function snapPx(value: number, dpr: number): number {
  return (Math.floor(value * dpr) + 0.5) / dpr;
}

function computeVolumeScale(
  bars: readonly AggregatedReplayBar[],
  startIdx: number,
  endIdx: number,
  blindMode: boolean,
  curBarIdx: number,
): number {
  const positive: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    if (blindMode && i > curBarIdx) continue;
    const v = bars[i]!.volume;
    if (v > 0) positive.push(v);
  }
  if (positive.length === 0) return 1;
  positive.sort((a, b) => a - b);
  const idx = Math.min(positive.length - 1, Math.floor(positive.length * 0.95));
  return Math.max(1, positive[idx]!);
}

function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}만`;
  return Math.round(value).toLocaleString("ko-KR");
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

function defaultViewportFor(totalBars: number): ChartViewport {
  if (totalBars <= 0) return { start: 0, end: 0 };
  return { start: 0, end: totalBars };
}

export type ReplaySubIndicator = "obi" | "strength" | "totals" | "program" | "none";

const SUB_INDICATOR_OPTIONS: readonly { readonly key: ReplaySubIndicator; readonly label: string }[] = [
  { key: "obi", label: "호가 잔량비" },
  { key: "strength", label: "체결강도" },
  { key: "totals", label: "총잔량" },
  { key: "program", label: "프로그램 누적" },
  { key: "none", label: "숨김" },
];

export function ReplayCharts({ session, engine, paper, blindMode, bookmarks, palette, onScrub }: Props) {
  const [timeframe, setTimeframe] = useState<ReplayChartTimeframe>(1);
  const [activeSub, setActiveSub] = useState<ReplaySubIndicator>("obi");
  const [panning, setPanning] = useState(false);
  const [renderTick, setRenderTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const totalsCanvasRef = useRef<HTMLCanvasElement>(null);
  const obiCanvasRef = useRef<HTMLCanvasElement>(null);
  const strengthCanvasRef = useRef<HTMLCanvasElement>(null);
  const programCanvasRef = useRef<HTMLCanvasElement>(null);

  const viewportRef = useRef<ChartViewport | null>(null);
  const activeViewportRef = useRef<ChartViewport>({ start: 0, end: 1 });
  const barsRef = useRef<readonly AggregatedReplayBar[]>([]);
  const hoverRef = useRef<HoverPoint | null>(null);
  const dragRef = useRef<DragPanState | null>(null);
  const paintNowRef = useRef<(() => void) | null>(null);

  const hmLabelRef = useRef<HTMLSpanElement>(null);
  const legendOpenRef = useRef<HTMLElement>(null);
  const legendHighRef = useRef<HTMLElement>(null);
  const legendLowRef = useRef<HTMLElement>(null);
  const legendCloseRef = useRef<HTMLElement>(null);
  const legendVwapRef = useRef<HTMLElement>(null);
  const totalsAskRef = useRef<HTMLElement>(null);
  const totalsBidRef = useRef<HTMLElement>(null);
  const obiValRef = useRef<HTMLElement>(null);
  const strengthValRef = useRef<HTMLElement>(null);
  const programValRef = useRef<HTMLElement>(null);

  useEffect(() => {
    viewportRef.current = null;
  }, [session, timeframe]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setRenderTick((t) => t + 1));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const total = barsRef.current.length;
      if (total <= 1) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const plotW = Math.max(10, rect.width - PAD_L - PAD_R);
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - PAD_L) / plotW));
      const factor = event.deltaY < 0 ? 0.84 : 1.19;
      const base = viewportRef.current ?? activeViewportRef.current;
      const next = zoomViewport(base, total, ratio, factor);
      viewportRef.current = next.end - next.start >= total - 0.01 ? null : next;
      paintNowRef.current?.();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const firstMin = session.minutes[0]?.minute ?? 540;

    const paint = (frame: ReplayEngineFrame) => {
      const cursorSec = frame.cursorMs / 1000;
      const curMin = Math.floor(cursorSec / 60);
      const bars = aggregateReplayBars(session.minutes, timeframe, frame, curMin);
      barsRef.current = bars;

      const totalBars = bars.length;
      let curBarIdx = 0;
      for (let i = 0; i < totalBars; i++) {
        if (bars[i]!.startMinute <= curMin) curBarIdx = i;
        else break;
      }

      const rawView = viewportRef.current !== null
        ? clampViewport(viewportRef.current, totalBars)
        : defaultViewportFor(totalBars);
      activeViewportRef.current = rawView;

      const viewSpan = Math.max(1, rawView.end - rawView.start);
      const startIdx = Math.max(0, Math.floor(rawView.start));
      const endIdx = Math.min(totalBars - 1, Math.ceil(rawView.end) - 1);

      const mainCanvas = mainCanvasRef.current;
      const mainRectW = mainCanvas ? Math.max(1, Math.round(mainCanvas.getBoundingClientRect().width)) : 300;
      const sharedPlotW = Math.max(10, mainRectW - PAD_L - PAD_R);

      const hover = hoverRef.current;
      let hoverBarIdx: number | null = null;
      if (hover !== null && totalBars > 0) {
        const hRatio = (hover.x - PAD_L) / sharedPlotW;
        if (hRatio >= 0 && hRatio <= 1) {
          const idx = Math.floor(rawView.start + hRatio * viewSpan);
          if (idx >= 0 && idx < totalBars) {
            hoverBarIdx = idx;
          }
        }
      }

      const displayIdx = hoverBarIdx !== null && !(blindMode && hoverBarIdx > curBarIdx)
        ? hoverBarIdx
        : curBarIdx;
      const displayBar = bars[displayIdx];
      const isShowingCur = displayIdx === curBarIdx;

      setText(
        hmLabelRef.current,
        displayBar ? formatReplayHM(displayBar.sec) : formatReplayHM(cursorSec),
      );
      if (displayBar) {
        setText(legendOpenRef.current, displayBar.open !== null ? formatPrice(displayBar.open, false) : "-");
        setText(legendHighRef.current, displayBar.high !== null ? formatPrice(displayBar.high, false) : "-");
        setText(legendLowRef.current, displayBar.low !== null ? formatPrice(displayBar.low, false) : "-");
        if (legendCloseRef.current) {
          legendCloseRef.current.className = displayBar.close !== null && displayBar.open !== null && displayBar.close >= displayBar.open ? "rp-up" : "rp-down";
          setText(legendCloseRef.current, displayBar.close !== null ? formatPrice(displayBar.close, false) : "-");
        }
        setText(legendVwapRef.current, displayBar.vwap !== null ? formatPrice(Math.round(displayBar.vwap), false) : "-");
      }

      const curTotalAsk = frame.inGap ? null : (frame.ladder.totalAsk > 0 || frame.resolution === "tick" ? frame.ladder.totalAsk : (displayBar?.totalAsk ?? null));
      const curTotalBid = frame.inGap ? null : (frame.ladder.totalBid > 0 || frame.resolution === "tick" ? frame.ladder.totalBid : (displayBar?.totalBid ?? null));
      const curObiVal = curTotalAsk !== null && curTotalBid !== null && curTotalAsk + curTotalBid > 0
        ? ((curTotalBid - curTotalAsk) / (curTotalBid + curTotalAsk)) * 100
        : (displayBar?.obi ?? null);
      const curStrengthVal = frame.strength ?? displayBar?.strength ?? null;
      const curProgramQty = frame.programNetQty ?? displayBar?.programNetQty ?? null;
      const curProgramAmt = frame.programNetAmtMillion ?? displayBar?.programNetAmtMillion ?? null;

      const shownAsk = isShowingCur ? curTotalAsk : (displayBar?.totalAsk ?? null);
      const shownBid = isShowingCur ? curTotalBid : (displayBar?.totalBid ?? null);
      const shownObi = isShowingCur ? curObiVal : (displayBar?.obi ?? null);
      const shownStrength = isShowingCur ? curStrengthVal : (displayBar?.strength ?? null);
      const shownProgQty = isShowingCur ? curProgramQty : (displayBar?.programNetQty ?? null);
      const shownProgAmt = isShowingCur ? curProgramAmt : (displayBar?.programNetAmtMillion ?? null);

      setText(totalsAskRef.current, shownAsk !== null ? formatPrice(shownAsk, false) : "-");
      setText(totalsBidRef.current, shownBid !== null ? formatPrice(shownBid, false) : "-");
      if (obiValRef.current) {
        obiValRef.current.className = shownObi !== null ? (shownObi > 0 ? "rp-up" : shownObi < 0 ? "rp-down" : "rp-muted") : "rp-muted";
        setText(obiValRef.current, shownObi !== null ? `${shownObi > 0 ? "+" : ""}${shownObi.toFixed(1)}%` : "-");
      }
      if (strengthValRef.current) {
        strengthValRef.current.className = shownStrength !== null ? (shownStrength >= 100 ? "rp-up" : "rp-down") : "rp-muted";
        setText(strengthValRef.current, shownStrength !== null ? `${shownStrength.toFixed(1)}%` : "-");
      }
      if (programValRef.current) {
        if (shownProgQty !== null) {
          programValRef.current.className = shownProgQty > 0 ? "rp-up" : shownProgQty < 0 ? "rp-down" : "rp-muted";
          setText(
            programValRef.current,
            `${formatSignedQty(shownProgQty)}주${shownProgAmt !== null ? ` (${formatWonCompact(shownProgAmt * 1_000_000)})` : ""}`,
          );
        } else {
          programValRef.current.className = "rp-muted";
          setText(programValRef.current, "자료 없음");
        }
      }

      const barCoordOfMinuteFloat = (minFloat: number) => (minFloat - firstMin) / timeframe;
      const curBarFloat = barCoordOfMinuteFloat(cursorSec / 60);

      if (mainCanvas && totalBars > 0) {
        const prep = prepareCanvas(mainCanvas);
        if (prep) {
          const { ctx, w, h, dpr } = prep;
          ctx.clearRect(0, 0, w, h);
          const padT = 26;
          const padB = 22;
          const plotW = Math.max(10, w - PAD_L - PAD_R);
          const plotH = Math.max(10, h - padT - padB);
          const volH = Math.round(plotH * 0.22);
          const priceH = Math.max(10, plotH - volH - 6);

          let minP = session.previousClose ?? Infinity;
          let maxP = session.previousClose ?? -Infinity;
          for (let i = startIdx; i <= endIdx; i++) {
            if (blindMode && i > curBarIdx) continue;
            const b = bars[i]!;
            if (b.low !== null && b.low < minP) minP = b.low;
            if (b.high !== null && b.high > maxP) maxP = b.high;
          }
          const volScale = computeVolumeScale(bars, startIdx, endIdx, blindMode, curBarIdx);
          const paperHolding = paper?.getHolding() ?? null;
          if (paperHolding && paperHolding.quantity > 0 && paperHolding.avgPrice > 0) {
            if (paperHolding.avgPrice < minP) minP = paperHolding.avgPrice;
            if (paperHolding.avgPrice > maxP) maxP = paperHolding.avgPrice;
          }
          if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
            minP = frame.price ?? 0;
            maxP = (frame.price ?? 0) + 100;
          }
          const padVal = Math.max(session.tickStepOf(Math.max(1, minP)) * 3, (maxP - minP) * 0.12);
          minP -= padVal;
          maxP += padVal;

          const xOf = (barFloat: number) => PAD_L + ((barFloat - rawView.start) / viewSpan) * plotW;
          const yOf = (price: number) => padT + (1 - (price - minP) / Math.max(1, maxP - minP)) * priceH;
          const pOfY = (y: number) => minP + (1 - (y - padT) / Math.max(1, priceH)) * (maxP - minP);

          ctx.strokeStyle = palette.line;
          ctx.fillStyle = palette.text3;
          ctx.font = `11px ${palette.fontMono}`;
          ctx.textAlign = "left";
          for (let g = 0; g <= 3; g++) {
            const p = minP + ((maxP - minP) * g) / 3;
            const y = Math.round(yOf(p)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(PAD_L, y);
            ctx.lineTo(PAD_L + plotW, y);
            ctx.stroke();
            ctx.fillText(formatPrice(Math.round(p), false), PAD_L + plotW + 4, y + 4);
          }

          for (const sw of session.singlePriceWindows) {
            const sCoord = barCoordOfMinuteFloat(sw.startSec / 60);
            const eCoord = barCoordOfMinuteFloat(sw.endSec / 60);
            if (eCoord < rawView.start || sCoord > rawView.end) continue;
            const x0 = xOf(Math.max(rawView.start, sCoord));
            const x1 = Math.max(x0 + 4, xOf(Math.min(rawView.end, eCoord)));
            ctx.fillStyle = palette.warningSoft;
            ctx.fillRect(x0, padT, x1 - x0, plotH);
          }

          for (const gw of session.gapWindows) {
            const sCoord = barCoordOfMinuteFloat(gw.startSec / 60);
            const eCoord = barCoordOfMinuteFloat(gw.endSec / 60);
            if (eCoord < rawView.start || sCoord > rawView.end) continue;
            const x0 = xOf(Math.max(rawView.start, sCoord));
            const x1 = Math.max(x0 + 4, xOf(Math.min(rawView.end, eCoord)));
            ctx.fillStyle = palette.dangerSoft;
            ctx.fillRect(x0, padT, x1 - x0, plotH);
          }

          if (session.previousClose !== null) {
            const prevY = Math.round(yOf(session.previousClose)) + 0.5;
            if (prevY >= padT && prevY <= padT + priceH) {
              ctx.save();
              ctx.setLineDash([4, 4]);
              ctx.strokeStyle = palette.lineStrong;
              ctx.beginPath();
              ctx.moveTo(PAD_L, prevY);
              ctx.lineTo(PAD_L + plotW, prevY);
              ctx.stroke();
              ctx.restore();
            }
          }

          const barW = Math.max(2, Math.min(20, Math.floor((plotW / viewSpan) * 0.7)));
          for (let i = startIdx; i <= endIdx; i++) {
            const b = bars[i]!;
            const isFuture = i > curBarIdx;
            if (blindMode && isFuture) continue;
            if (b.open === null || b.high === null || b.low === null || b.close === null) continue;
            const x = snapPx(xOf(i + 0.5), dpr);
            const left = Math.round(x - barW / 2);
            const isUp = b.close >= b.open;
            const col = isUp ? palette.up : palette.down;
            ctx.globalAlpha = isFuture ? 0.25 : 0.98;

            if (b.volume > 0) {
              const clipped = b.volume > volScale;
              const vh = Math.max(1.5, Math.min(volH, (b.volume / volScale) * volH));
              ctx.fillStyle = isUp ? palette.upVol : palette.downVol;
              ctx.fillRect(left, Math.round(padT + plotH - vh), barW, Math.round(vh));
              if (clipped) {
                ctx.fillStyle = palette.ind1;
                ctx.fillRect(left, Math.round(padT + plotH - volH), barW, 2);
              }
            }

            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, snapPx(yOf(b.high), dpr));
            ctx.lineTo(x, snapPx(yOf(b.low), dpr));
            ctx.stroke();

            const yO = yOf(b.open);
            const yC = yOf(b.close);
            const topY = Math.round(Math.min(yO, yC));
            const bodyH = Math.max(1.5, Math.round(Math.abs(yC - yO)));
            ctx.fillStyle = col;
            ctx.fillRect(left, topY, barW, bodyH);
          }
          ctx.globalAlpha = 1;

          ctx.beginPath();
          ctx.strokeStyle = palette.ind1;
          ctx.lineWidth = 1.4;
          let started = false;
          for (let i = startIdx; i <= endIdx; i++) {
            if (blindMode && i > curBarIdx) break;
            const b = bars[i]!;
            if (b.vwap === null) continue;
            const x = xOf(i + 0.5);
            const y = yOf(b.vwap);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();

          for (const bm of bookmarks) {
            const bCoord = barCoordOfMinuteFloat(bm / 60);
            if (bCoord < rawView.start || bCoord > rawView.end) continue;
            const bx = xOf(bCoord);
            ctx.save();
            ctx.strokeStyle = palette.accent;
            ctx.globalAlpha = 0.55;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(bx, padT);
            ctx.lineTo(bx, padT + plotH);
            ctx.stroke();
            ctx.restore();
          }

          if (paperHolding && paperHolding.quantity > 0 && paperHolding.avgPrice > 0) {
            const avgY = Math.round(yOf(paperHolding.avgPrice)) + 0.5;
            if (avgY >= padT && avgY <= padT + priceH) {
              ctx.save();
              ctx.setLineDash([4, 4]);
              ctx.strokeStyle = palette.up;
              ctx.lineWidth = 1.3;
              ctx.beginPath();
              ctx.moveTo(PAD_L, avgY);
              ctx.lineTo(PAD_L + plotW, avgY);
              ctx.stroke();
              ctx.restore();
              ctx.fillStyle = palette.up;
              ctx.fillRect(PAD_L + plotW + 2, avgY - 8, 54, 16);
              ctx.fillStyle = palette.accentInk;
              ctx.font = `700 11px ${palette.fontMono}`;
              ctx.textAlign = "left";
              ctx.fillText("평단", PAD_L + plotW + 6, avgY + 4);
            }
          }

          if (paper) {
            for (const fill of paper.getFills()) {
              const fCoord = barCoordOfMinuteFloat(fill.ms / 60_000);
              if (fCoord < rawView.start || fCoord > rawView.end) continue;
              const fx = xOf(fCoord);
              const fy = Math.max(padT + 8, Math.min(padT + priceH - 8, yOf(fill.price)));
              ctx.fillStyle = fill.side === "buy" ? palette.up : palette.down;
              ctx.beginPath();
              if (fill.side === "buy") {
                ctx.moveTo(fx, fy + 4);
                ctx.lineTo(fx - 5, fy + 12);
                ctx.lineTo(fx + 5, fy + 12);
              } else {
                ctx.moveTo(fx, fy - 4);
                ctx.lineTo(fx - 5, fy - 12);
                ctx.lineTo(fx + 5, fy - 12);
              }
              ctx.closePath();
              ctx.fill();
            }
          }

          const playX = xOf(curBarFloat);
          if (blindMode && playX < PAD_L + plotW) {
            ctx.save();
            ctx.fillStyle = palette.surface;
            ctx.globalAlpha = 0.82;
            const blindLeft = Math.max(PAD_L, playX);
            ctx.fillRect(blindLeft, padT, PAD_L + plotW - blindLeft, plotH);
            ctx.globalAlpha = 1;
            if (PAD_L + plotW - blindLeft > 110) {
              ctx.fillStyle = palette.text3;
              ctx.font = `600 11px ${palette.fontSans}`;
              ctx.textAlign = "center";
              ctx.fillText("블라인드 복기 (H 해제)", blindLeft + (PAD_L + plotW - blindLeft) / 2, padT + priceH / 2);
            }
            ctx.restore();
          }

          if (playX >= PAD_L && playX <= PAD_L + plotW) {
            ctx.strokeStyle = palette.accent;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(playX, padT);
            ctx.lineTo(playX, padT + plotH);
            ctx.stroke();

            if (frame.price !== null) {
              const py = Math.max(padT + 8, Math.min(padT + priceH - 8, yOf(frame.price)));
              ctx.fillStyle = palette.accent;
              ctx.fillRect(PAD_L + plotW + 2, py - 8, 54, 16);
              ctx.fillStyle = palette.accentInk;
              ctx.font = `700 11px ${palette.fontMono}`;
              ctx.textAlign = "left";
              ctx.fillText(formatPrice(frame.price, false), PAD_L + plotW + 4, py + 4);
            }
          }

          ctx.fillStyle = palette.text3;
          ctx.font = `11px ${palette.fontMono}`;
          ctx.textAlign = "center";
          const labelEvery = Math.max(1, Math.ceil(viewSpan / 6));
          for (let i = startIdx; i <= endIdx; i += labelEvery) {
            const lx = xOf(i + 0.5);
            if (lx < PAD_L + 22 || lx > PAD_L + plotW - 22) continue;
            ctx.fillText(formatReplayHM(bars[i]!.sec), lx, h - 6);
          }

          if (hover !== null && hoverBarIdx !== null) {
            const hx = Math.round(xOf(hoverBarIdx + 0.5)) + 0.5;
            if (hx >= PAD_L && hx <= PAD_L + plotW) {
              ctx.save();
              ctx.strokeStyle = palette.lineStrong;
              ctx.setLineDash([3, 3]);
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(hx, padT);
              ctx.lineTo(hx, padT + plotH);
              ctx.stroke();
              if (hover.pane === "main" && hover.y >= padT && hover.y <= padT + priceH) {
                const hy = Math.round(hover.y) + 0.5;
                ctx.beginPath();
                ctx.moveTo(PAD_L, hy);
                ctx.lineTo(PAD_L + plotW, hy);
                ctx.stroke();
                ctx.setLineDash([]);
                const hPrice = pOfY(hover.y);
                const step = Math.max(1, session.tickStepOf(Math.max(1, hPrice)));
                const snapped = Math.round(hPrice / step) * step;
                ctx.fillStyle = palette.text;
                ctx.fillRect(PAD_L + plotW + 2, hy - 8, 54, 16);
                ctx.fillStyle = palette.bg;
                ctx.font = `600 11px ${palette.fontMono}`;
                ctx.textAlign = "left";
                ctx.fillText(formatPrice(snapped, false), PAD_L + plotW + 4, hy + 4);
              }
              ctx.setLineDash([]);
              const tagW = 42;
              const tagX = Math.max(PAD_L, Math.min(PAD_L + plotW - tagW, hx - tagW / 2));
              ctx.fillStyle = palette.text;
              ctx.fillRect(tagX, h - 15, tagW, 14);
              ctx.fillStyle = palette.bg;
              ctx.font = `600 11px ${palette.fontMono}`;
              ctx.textAlign = "center";
              ctx.fillText(formatReplayHM(bars[hoverBarIdx]!.sec), tagX + tagW / 2, h - 4);
              ctx.restore();
            }
          }
        }
      }

      const drawSingleSub = (
        canvas: HTMLCanvasElement | null,
        getter: (b: AggregatedReplayBar) => number | null,
        liveOverride: number | null,
        zeroVal: number,
        posColor: string,
        negColor: string,
        fmtAxis: (v: number) => string,
      ) => {
        if (!canvas || totalBars === 0) return;
        const prep = prepareCanvas(canvas);
        if (!prep) return;
        const { ctx, w, h } = prep;
        ctx.clearRect(0, 0, w, h);
        const padT = 18;
        const padB = 6;
        const plotW = Math.max(10, w - PAD_L - PAD_R);
        const plotH = Math.max(10, h - padT - padB);

        const valueAt = (idx: number) => (idx === curBarIdx && liveOverride !== null ? liveOverride : getter(bars[idx]!));

        let minV = zeroVal;
        let maxV = zeroVal;
        let hasAny = false;
        for (let i = startIdx; i <= endIdx; i++) {
          if (blindMode && i > curBarIdx) continue;
          const v = valueAt(i);
          if (v === null) continue;
          hasAny = true;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const span = Math.max(1, maxV - minV);
        minV -= span * 0.14;
        maxV += span * 0.14;

        const xOf = (barFloat: number) => PAD_L + ((barFloat - rawView.start) / viewSpan) * plotW;
        const yOf = (v: number) => padT + (1 - (v - minV) / Math.max(0.001, maxV - minV)) * plotH;
        const zeroY = yOf(zeroVal);

        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = palette.line;
        ctx.beginPath();
        ctx.moveTo(PAD_L, zeroY);
        ctx.lineTo(PAD_L + plotW, zeroY);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = palette.text3;
        ctx.font = `11px ${palette.fontMono}`;
        ctx.textAlign = "left";
        if (hasAny) {
          ctx.fillText(fmtAxis(maxV), PAD_L + plotW + 4, padT + 7);
          ctx.fillText(fmtAxis(minV), PAD_L + plotW + 4, padT + plotH);
        }

        const drawSeg = (fromI: number, toI: number, alpha: number) => {
          if (toI < fromI) return;
          let lastValid: number | null = null;
          for (let i = toI; i >= fromI; i--) {
            const v = valueAt(i);
            if (v !== null) {
              lastValid = v;
              break;
            }
          }
          if (lastValid === null) return;
          const strokeCol = lastValid >= zeroVal ? posColor : negColor;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          let started = false;
          for (let i = fromI; i <= toI; i++) {
            const v = valueAt(i);
            if (v === null) {
              started = false;
              continue;
            }
            const x = xOf(i + 0.5);
            const y = yOf(v);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
          ctx.restore();
        };

        const pastEnd = Math.min(endIdx, curBarIdx);
        if (pastEnd >= startIdx) drawSeg(startIdx, pastEnd, 1);
        if (!blindMode && endIdx > curBarIdx) {
          drawSeg(Math.max(startIdx, curBarIdx), endIdx, 0.25);
        }

        const px = xOf(curBarFloat);
        if (px >= PAD_L && px <= PAD_L + plotW) {
          if (blindMode) {
            ctx.save();
            ctx.fillStyle = palette.surface;
            ctx.globalAlpha = 0.82;
            ctx.fillRect(px, padT, PAD_L + plotW - px, plotH);
            ctx.restore();
          }
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, h);
          ctx.stroke();
        }

        if (hoverBarIdx !== null) {
          const hx = Math.round(xOf(hoverBarIdx + 0.5)) + 0.5;
          if (hx >= PAD_L && hx <= PAD_L + plotW) {
            ctx.save();
            ctx.strokeStyle = palette.lineStrong;
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(hx, 0);
            ctx.lineTo(hx, h);
            ctx.stroke();
            ctx.restore();
          }
        }
      };

      const totalsCanvas = totalsCanvasRef.current;
      if (totalsCanvas && totalBars > 0) {
        const prep = prepareCanvas(totalsCanvas);
        if (prep) {
          const { ctx, w, h } = prep;
          ctx.clearRect(0, 0, w, h);
          const padT = 18;
          const padB = 6;
          const plotW = Math.max(10, w - PAD_L - PAD_R);
          const plotH = Math.max(10, h - padT - padB);

          const askAt = (idx: number) => (idx === curBarIdx && curTotalAsk !== null ? curTotalAsk : bars[idx]!.totalAsk);
          const bidAt = (idx: number) => (idx === curBarIdx && curTotalBid !== null ? curTotalBid : bars[idx]!.totalBid);

          let minV = Infinity;
          let maxV = -Infinity;
          for (let i = startIdx; i <= endIdx; i++) {
            if (blindMode && i > curBarIdx) continue;
            const a = askAt(i);
            const b = bidAt(i);
            if (a !== null) {
              if (a < minV) minV = a;
              if (a > maxV) maxV = a;
            }
            if (b !== null) {
              if (b < minV) minV = b;
              if (b > maxV) maxV = b;
            }
          }
          if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
            minV = 0;
            maxV = 1000;
          }
          const span = Math.max(10, maxV - minV);
          minV = Math.max(0, minV - span * 0.12);
          maxV += span * 0.12;

          const xOf = (barFloat: number) => PAD_L + ((barFloat - rawView.start) / viewSpan) * plotW;
          const yOf = (v: number) => padT + (1 - (v - minV) / Math.max(1, maxV - minV)) * plotH;

          ctx.fillStyle = palette.text3;
          ctx.font = `11px ${palette.fontMono}`;
          ctx.textAlign = "left";
          ctx.fillText(formatCompactCount(maxV), PAD_L + plotW + 4, padT + 7);
          ctx.fillText(formatCompactCount(minV), PAD_L + plotW + 4, padT + plotH);

          const drawLine = (fromI: number, toI: number, get: (idx: number) => number | null, color: string, alpha: number) => {
            if (toI < fromI) return;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            let started = false;
            for (let i = fromI; i <= toI; i++) {
              const v = get(i);
              if (v === null) {
                started = false;
                continue;
              }
              const x = xOf(i + 0.5);
              const y = yOf(v);
              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              } else {
                ctx.lineTo(x, y);
              }
            }
            ctx.stroke();
            ctx.restore();
          };

          const pastEnd = Math.min(endIdx, curBarIdx);
          if (pastEnd >= startIdx) {
            drawLine(startIdx, pastEnd, askAt, palette.down, 1);
            drawLine(startIdx, pastEnd, bidAt, palette.up, 1);
          }
          if (!blindMode && endIdx > curBarIdx) {
            drawLine(Math.max(startIdx, curBarIdx), endIdx, askAt, palette.down, 0.25);
            drawLine(Math.max(startIdx, curBarIdx), endIdx, bidAt, palette.up, 0.25);
          }

          const px = xOf(curBarFloat);
          if (px >= PAD_L && px <= PAD_L + plotW) {
            if (blindMode) {
              ctx.save();
              ctx.fillStyle = palette.surface;
              ctx.globalAlpha = 0.82;
              ctx.fillRect(px, padT, PAD_L + plotW - px, plotH);
              ctx.restore();
            }
            ctx.strokeStyle = palette.accent;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
          }

          if (hoverBarIdx !== null) {
            const hx = Math.round(xOf(hoverBarIdx + 0.5)) + 0.5;
            if (hx >= PAD_L && hx <= PAD_L + plotW) {
              ctx.save();
              ctx.strokeStyle = palette.lineStrong;
              ctx.setLineDash([3, 3]);
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(hx, 0);
              ctx.lineTo(hx, h);
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }

      drawSingleSub(
        obiCanvasRef.current,
        (b) => b.obi,
        curObiVal,
        0,
        palette.up,
        palette.down,
        (v) => `${v >= 0 ? "+" : ""}${Math.round(v)}%`,
      );
      drawSingleSub(
        strengthCanvasRef.current,
        (b) => b.strength,
        curStrengthVal,
        100,
        palette.up,
        palette.down,
        (v) => `${Math.round(v)}%`,
      );
      drawSingleSub(
        programCanvasRef.current,
        (b) => b.programNetQty,
        curProgramQty,
        0,
        palette.up,
        palette.down,
        formatCompactCount,
      );
    };

    paintNowRef.current = () => paint(engine.getFrame());
    const unsubFrame = engine.subscribeFrame(paint);
    const unsubPaper = paper ? paper.subscribe(() => paint(engine.getFrame())) : undefined;
    return () => {
      paintNowRef.current = null;
      unsubFrame();
      unsubPaper?.();
    };
  }, [session, engine, paper, blindMode, bookmarks, palette, timeframe, activeSub, renderTick]);

  const scrubAtClientX = (targetEl: HTMLElement, clientX: number) => {
    const rect = targetEl.getBoundingClientRect();
    const plotW = Math.max(10, rect.width - PAD_L - PAD_R);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - PAD_L) / plotW));
    const view = activeViewportRef.current;
    const barFloat = view.start + ratio * Math.max(1, view.end - view.start);
    const firstMin = session.minutes[0]?.minute ?? 540;
    const minute = firstMin + barFloat * timeframe;
    onScrub(minute * 60);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const plotW = Math.max(10, rect.width - PAD_L - PAD_R);
    dragRef.current = {
      startX: event.clientX,
      startView: activeViewportRef.current,
      plotW,
      totalBars: barsRef.current.length,
      dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (pane: "main" | "sub", event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    hoverRef.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pane,
    };
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.startX;
      if (!drag.dragged && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
        drag.dragged = true;
        setPanning(true);
      }
      if (drag.dragged) {
        const span = Math.max(1, drag.startView.end - drag.startView.start);
        const deltaBars = -(dx / drag.plotW) * span;
        viewportRef.current = panViewport(drag.startView, drag.totalBars, deltaBars);
      }
    }
    paintNowRef.current?.();
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (drag && !drag.dragged) {
      scrubAtClientX(event.currentTarget, event.clientX);
    }
  };

  const handlePointerLeave = () => {
    if (!dragRef.current) {
      hoverRef.current = null;
      paintNowRef.current?.();
    }
  };

  const handleResetZoom = () => {
    viewportRef.current = null;
    paintNowRef.current?.();
  };

  return (
    <section className="rp-col" aria-label="분봉 차트와 4대 보조지표">
      <div className="rp-pane-head">
        <div className="rp-pane-title">
          <span>{`${timeframe}분봉 · VWAP`}</span>
          <span ref={hmLabelRef} className="rp-muted rp-mono">09:00</span>
        </div>
        <div className="rp-pane-controls">
          <div className="rp-seg rp-mono" role="group" aria-label="분봉 주기" data-testid="replay-chart-timeframe">
            {REPLAY_CHART_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                aria-pressed={timeframe === tf}
                onClick={() => setTimeframe(tf)}
              >
                {`${tf}분`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={rootRef} className="rp-left-stack" data-panning={panning ? "true" : undefined}>
        <div
          className="rp-chart-wrap"
          data-testid="replay-main-chart"
          data-timeframe={String(timeframe)}
          onPointerDown={handlePointerDown}
          onPointerMove={(e) => handlePointerMove("main", e)}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleResetZoom}
        >
          <canvas ref={mainCanvasRef} className="rp-canvas" />
          <div className="rp-chart-legend rp-mono">
            <span>시<b ref={legendOpenRef}>-</b></span>
            <span>고<b ref={legendHighRef} className="rp-up">-</b></span>
            <span>저<b ref={legendLowRef} className="rp-down">-</b></span>
            <span>종<b ref={legendCloseRef}>-</b></span>
            <span>VWAP<b ref={legendVwapRef} className="rp-warn">-</b></span>
          </div>
        </div>

        <div className="rp-sub-section" data-testid="replay-sub-indicators">
          <div className="rp-sub-bar" role="group" aria-label="보조 흐름 선택">
            {SUB_INDICATOR_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className="rp-sub-tab"
                data-indicator-tab={opt.key}
                aria-pressed={activeSub === opt.key}
                onClick={() => setActiveSub(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {activeSub !== "none" && (
            <div className="rp-sub-single">
              {activeSub === "totals" && (
                <div
                  className="rp-sub-pane"
                  data-indicator="totals"
                  onPointerDown={handlePointerDown}
                  onPointerMove={(e) => handlePointerMove("sub", e)}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  onDoubleClick={handleResetZoom}
                >
                  <div className="rp-sub-overlay rp-mono">
                    <span className="rp-sub-name">총잔량</span>
                    <span className="rp-sub-vals">
                      <span className="rp-down"><i className="rp-sw-dot" data-tone="down" />매도 <b ref={totalsAskRef}>-</b></span>
                      <span className="rp-up"><i className="rp-sw-dot" data-tone="up" />매수 <b ref={totalsBidRef}>-</b></span>
                    </span>
                  </div>
                  <canvas ref={totalsCanvasRef} className="rp-canvas" />
                </div>
              )}

              {activeSub === "obi" && (
                <div
                  className="rp-sub-pane"
                  data-indicator="obi"
                  onPointerDown={handlePointerDown}
                  onPointerMove={(e) => handlePointerMove("sub", e)}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  onDoubleClick={handleResetZoom}
                >
                  <div className="rp-sub-overlay rp-mono">
                    <span className="rp-sub-name">호가 잔량비</span>
                    <span className="rp-sub-vals">
                      <b ref={obiValRef} className="rp-muted">-</b>
                    </span>
                  </div>
                  <canvas ref={obiCanvasRef} className="rp-canvas" />
                </div>
              )}

              {activeSub === "strength" && (
                <div
                  className="rp-sub-pane"
                  data-indicator="strength"
                  onPointerDown={handlePointerDown}
                  onPointerMove={(e) => handlePointerMove("sub", e)}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  onDoubleClick={handleResetZoom}
                >
                  <div className="rp-sub-overlay rp-mono">
                    <span className="rp-sub-name">체결강도</span>
                    <span className="rp-sub-vals">
                      <b ref={strengthValRef} className="rp-muted">-</b>
                    </span>
                  </div>
                  <canvas ref={strengthCanvasRef} className="rp-canvas" />
                </div>
              )}

              {activeSub === "program" && (
                <div
                  className="rp-sub-pane"
                  data-indicator="program"
                  onPointerDown={handlePointerDown}
                  onPointerMove={(e) => handlePointerMove("sub", e)}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerLeave}
                  onDoubleClick={handleResetZoom}
                >
                  <div className="rp-sub-overlay rp-mono">
                    <span className="rp-sub-name">프로그램 누적</span>
                    <span className="rp-sub-vals">
                      <b ref={programValRef} className="rp-muted">자료 없음</b>
                    </span>
                  </div>
                  <canvas ref={programCanvasRef} className="rp-canvas" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
