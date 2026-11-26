import { type PointerEvent, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../lib/format";
import { type CanvasPalette } from "./canvasTheme";
import type { ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import {
  formatReplayHM,
  formatSignedQty,
  formatWonCompact,
  type ReplayMinutePoint,
  type ReplaySession,
} from "./replayModel";

export type ChartRangeMode = "all" | "focus";

interface Props {
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly blindMode: boolean;
  readonly bookmarks: readonly number[];
  readonly palette: CanvasPalette;
  readonly onScrub: (sec: number) => void;
}

const PAD_L = 8;
const PAD_R = 58;

function prepareCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
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
  return { ctx, w, h };
}

function visibleBounds(session: ReplaySession, cursorSec: number, range: ChartRangeMode) {
  const total = session.minutes.length;
  if (range === "all" || total <= 61) return { startIdx: 0, endIdx: Math.max(0, total - 1) };
  const firstMin = session.minutes[0]?.minute ?? 0;
  const curOffset = Math.floor(cursorSec / 60) - firstMin;
  const startIdx = Math.max(0, Math.min(total - 61, curOffset - 30));
  return { startIdx, endIdx: Math.min(total - 1, startIdx + 60) };
}

function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}만`;
  return Math.round(value).toLocaleString("ko-KR");
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

function resolvedBarForMinute(bar: ReplayMinutePoint, frame: ReplayEngineFrame, isCurrent: boolean): ReplayMinutePoint {
  if (!isCurrent || frame.resolution !== "tick") return bar;
  if (frame.formingBar && frame.formingBar.minute === bar.minute) {
    return {
      ...bar,
      open: frame.formingBar.open,
      high: frame.formingBar.high,
      low: frame.formingBar.low,
      close: frame.formingBar.close,
      volume: frame.formingBar.volume,
      vwap: frame.vwap ?? bar.vwap,
    };
  }
  if (frame.price !== null) {
    return {
      ...bar,
      open: frame.price,
      high: frame.price,
      low: frame.price,
      close: frame.price,
      volume: 0,
      vwap: frame.vwap ?? bar.vwap,
    };
  }
  return { ...bar, open: null, high: null, low: null, close: null, volume: 0 };
}

export function ReplayCharts({ session, engine, blindMode, bookmarks, palette, onScrub }: Props) {
  const [range, setRange] = useState<ChartRangeMode>("all");
  const [resizeTick, setResizeTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const totalsCanvasRef = useRef<HTMLCanvasElement>(null);
  const obiCanvasRef = useRef<HTMLCanvasElement>(null);
  const strengthCanvasRef = useRef<HTMLCanvasElement>(null);
  const programCanvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const latestCursorSecRef = useRef(session.sessionStartSec);

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
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setResizeTick((t) => t + 1));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const firstMin = session.minutes[0]?.minute ?? 540;

    const paint = (frame: ReplayEngineFrame) => {
      const cursorSec = frame.cursorMs / 1000;
      latestCursorSecRef.current = cursorSec;
      const curMinFloat = cursorSec / 60 - firstMin;
      const curIdx = Math.max(0, Math.min(session.minutes.length - 1, Math.floor(curMinFloat)));
      const rawCurBar = session.minutes[curIdx];
      const curBar = rawCurBar ? resolvedBarForMinute(rawCurBar, frame, true) : undefined;

      setText(hmLabelRef.current, formatReplayHM(cursorSec));
      if (curBar) {
        setText(legendOpenRef.current, curBar.open !== null ? formatPrice(curBar.open, false) : "-");
        setText(legendHighRef.current, curBar.high !== null ? formatPrice(curBar.high, false) : "-");
        setText(legendLowRef.current, curBar.low !== null ? formatPrice(curBar.low, false) : "-");
        if (legendCloseRef.current) {
          legendCloseRef.current.className = curBar.close !== null && curBar.open !== null && curBar.close >= curBar.open ? "rp-up" : "rp-down";
          setText(legendCloseRef.current, curBar.close !== null ? formatPrice(curBar.close, false) : "-");
        }
        setText(legendVwapRef.current, curBar.vwap !== null ? formatPrice(Math.round(curBar.vwap), false) : "-");
      }

      const totalAsk = frame.inGap ? null : (frame.ladder.totalAsk > 0 || frame.resolution === "tick" ? frame.ladder.totalAsk : (curBar?.totalAsk ?? null));
      const totalBid = frame.inGap ? null : (frame.ladder.totalBid > 0 || frame.resolution === "tick" ? frame.ladder.totalBid : (curBar?.totalBid ?? null));
      const obiVal = totalAsk !== null && totalBid !== null && totalAsk + totalBid > 0
        ? ((totalBid - totalAsk) / (totalBid + totalAsk)) * 100
        : (curBar?.obi ?? null);
      const strengthVal = frame.strength ?? curBar?.strength ?? null;
      const programQty = frame.programNetQty ?? curBar?.programNetQty ?? null;
      const programAmt = frame.programNetAmtMillion ?? curBar?.programNetAmtMillion ?? null;

      setText(totalsAskRef.current, totalAsk !== null ? formatPrice(totalAsk, false) : "-");
      setText(totalsBidRef.current, totalBid !== null ? formatPrice(totalBid, false) : "-");
      if (obiValRef.current) {
        obiValRef.current.className = obiVal !== null ? (obiVal >= 0 ? "rp-up" : "rp-down") : "rp-muted";
        setText(obiValRef.current, obiVal !== null ? `${obiVal >= 0 ? "+" : ""}${obiVal.toFixed(1)}%` : "-");
      }
      if (strengthValRef.current) {
        strengthValRef.current.className = strengthVal !== null ? (strengthVal >= 100 ? "rp-up" : "rp-down") : "rp-muted";
        setText(strengthValRef.current, strengthVal !== null ? `${strengthVal.toFixed(1)}%` : "-");
      }
      if (programValRef.current) {
        if (programQty !== null) {
          programValRef.current.className = programQty >= 0 ? "rp-up" : "rp-down";
          setText(
            programValRef.current,
            `${formatSignedQty(programQty)}주${programAmt !== null ? ` (${formatWonCompact(programAmt * 1_000_000)})` : ""}`,
          );
        } else {
          programValRef.current.className = "rp-muted";
          setText(programValRef.current, "자료 없음");
        }
      }

      const { startIdx, endIdx } = visibleBounds(session, cursorSec, range);
      const visible = session.minutes.slice(startIdx, endIdx + 1);
      const count = Math.max(1, endIdx - startIdx + 1);
      const splitIdx = visible.findIndex((_, i) => startIdx + i > curIdx);
      const pastEnd = splitIdx === -1 ? visible.length - 1 : Math.max(-1, splitIdx - 1);

      const mainCanvas = mainCanvasRef.current;
      if (mainCanvas && visible.length > 0) {
        const prep = prepareCanvas(mainCanvas);
        if (prep) {
          const { ctx, w, h } = prep;
          ctx.clearRect(0, 0, w, h);
          const padT = 26;
          const padB = 18;
          const plotW = Math.max(10, w - PAD_L - PAD_R);
          const plotH = Math.max(10, h - padT - padB);
          const volH = Math.round(plotH * 0.2);
          const priceH = Math.max(10, plotH - volH - 4);

          let minP = session.previousClose ?? Infinity;
          let maxP = session.previousClose ?? -Infinity;
          let maxV = 1;
          for (let i = 0; i < visible.length; i++) {
            const absIdx = startIdx + i;
            if (blindMode && absIdx > curIdx) continue;
            const b = resolvedBarForMinute(visible[i]!, frame, absIdx === curIdx);
            if (b.low !== null && b.low < minP) minP = b.low;
            if (b.high !== null && b.high > maxP) maxP = b.high;
            if (b.volume > maxV) maxV = b.volume;
          }
          if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
            minP = frame.price ?? 0;
            maxP = (frame.price ?? 0) + 100;
          }
          const padVal = Math.max(session.tickStepOf(Math.max(1, minP)) * 3, (maxP - minP) * 0.12);
          minP -= padVal;
          maxP += padVal;

          const xOf = (idx: number) => PAD_L + ((idx - startIdx + 0.5) / count) * plotW;
          const yOf = (price: number) => padT + (1 - (price - minP) / Math.max(1, maxP - minP)) * priceH;

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
            const sIdx = sw.startSec / 60 - firstMin;
            const eIdx = sw.endSec / 60 - firstMin;
            if (eIdx < startIdx || sIdx > endIdx) continue;
            const x0 = xOf(Math.max(startIdx, sIdx));
            const x1 = Math.max(x0 + 4, xOf(Math.min(endIdx, eIdx)));
            ctx.fillStyle = palette.warningSoft;
            ctx.fillRect(x0, padT, x1 - x0, plotH);
          }

          for (const gw of session.gapWindows) {
            const sIdx = gw.startSec / 60 - firstMin;
            const eIdx = gw.endSec / 60 - firstMin;
            if (eIdx < startIdx || sIdx > endIdx) continue;
            const x0 = xOf(Math.max(startIdx, sIdx));
            const x1 = Math.max(x0 + 4, xOf(Math.min(endIdx, eIdx)));
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

          const barW = Math.max(1.5, (plotW / count) * 0.66);
          for (let i = 0; i < visible.length; i++) {
            const absIdx = startIdx + i;
            const isFuture = absIdx > curIdx;
            if (blindMode && isFuture) continue;
            const b = resolvedBarForMinute(visible[i]!, frame, absIdx === curIdx);
            if (b.open === null || b.high === null || b.low === null || b.close === null) continue;
            const x = xOf(absIdx);
            const isUp = b.close >= b.open;
            const col = isUp ? palette.up : palette.down;
            ctx.globalAlpha = isFuture ? 0.25 : 0.95;

            const vh = (b.volume / maxV) * volH;
            ctx.fillStyle = isUp ? palette.upVol : palette.downVol;
            ctx.fillRect(x - barW / 2, padT + plotH - vh, barW, vh);

            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, yOf(b.high));
            ctx.lineTo(x, yOf(b.low));
            ctx.stroke();

            const yO = yOf(b.open);
            const yC = yOf(b.close);
            ctx.fillStyle = col;
            ctx.fillRect(x - barW / 2, Math.min(yO, yC), barW, Math.max(1.2, Math.abs(yC - yO)));
          }
          ctx.globalAlpha = 1;

          ctx.beginPath();
          ctx.strokeStyle = palette.ind1;
          ctx.lineWidth = 1.4;
          let started = false;
          for (let i = 0; i < visible.length; i++) {
            const absIdx = startIdx + i;
            if (blindMode && absIdx > curIdx) break;
            const b = resolvedBarForMinute(visible[i]!, frame, absIdx === curIdx);
            if (b.vwap === null) continue;
            const x = xOf(absIdx);
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
            const bIdx = bm / 60 - firstMin;
            if (bIdx < startIdx || bIdx > endIdx) continue;
            const bx = xOf(bIdx);
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

          const playX = xOf(curMinFloat);
          if (blindMode && playX < PAD_L + plotW) {
            ctx.save();
            ctx.fillStyle = palette.surface;
            ctx.globalAlpha = 0.82;
            ctx.fillRect(playX, padT, PAD_L + plotW - playX, plotH);
            ctx.globalAlpha = 1;
            if (PAD_L + plotW - playX > 110) {
              ctx.fillStyle = palette.text3;
              ctx.font = `600 11px ${palette.fontSans}`;
              ctx.textAlign = "center";
              ctx.fillText("블라인드 복기 (H 해제)", playX + (PAD_L + plotW - playX) / 2, padT + priceH / 2);
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
          const step = range === "all" ? 60 : 15;
          for (let i = 0; i < visible.length; i++) {
            const m = visible[i]!.minute;
            if (m % step !== 0) continue;
            const lx = xOf(startIdx + i);
            if (lx < PAD_L + 22 || lx > PAD_L + plotW - 22) continue;
            ctx.fillText(formatReplayHM(m * 60), lx, h - 4);
          }
        }
      }

      const drawSingleSub = (
        canvas: HTMLCanvasElement | null,
        getter: (i: number) => number | null,
        liveOverride: number | null,
        zeroVal: number,
        posColor: string,
        negColor: string,
        fmtAxis: (v: number) => string,
      ) => {
        if (!canvas || visible.length === 0) return;
        const prep = prepareCanvas(canvas);
        if (!prep) return;
        const { ctx, w, h } = prep;
        ctx.clearRect(0, 0, w, h);
        const padT = 18;
        const padB = 6;
        const plotW = Math.max(10, w - PAD_L - PAD_R);
        const plotH = Math.max(10, h - padT - padB);

        const valueAt = (i: number) => (startIdx + i === curIdx && liveOverride !== null ? liveOverride : getter(i));

        let minV = zeroVal;
        let maxV = zeroVal;
        let hasAny = false;
        for (let i = 0; i < visible.length; i++) {
          if (blindMode && startIdx + i > curIdx) continue;
          const v = valueAt(i);
          if (v === null) continue;
          hasAny = true;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const span = Math.max(1, maxV - minV);
        minV -= span * 0.14;
        maxV += span * 0.14;

        const xOf = (idx: number) => PAD_L + ((idx - startIdx + 0.5) / count) * plotW;
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
          let firstX = 0;
          let lastX = 0;
          for (let i = fromI; i <= toI; i++) {
            const v = valueAt(i);
            if (v === null) {
              started = false;
              continue;
            }
            const x = xOf(startIdx + i);
            const y = yOf(v);
            if (!started) {
              ctx.moveTo(x, y);
              firstX = x;
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
            lastX = x;
          }
          ctx.stroke();
          if (started && lastX > firstX) {
            ctx.lineTo(lastX, zeroY);
            ctx.lineTo(firstX, zeroY);
            ctx.closePath();
            ctx.fillStyle = strokeCol;
            ctx.globalAlpha = alpha * 0.12;
            ctx.fill();
          }
          ctx.restore();
        };

        if (pastEnd >= 0) drawSeg(0, pastEnd, 1);
        if (!blindMode && splitIdx !== -1) drawSeg(Math.max(0, pastEnd), visible.length - 1, 0.25);

        const px = xOf(curMinFloat);
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
      };

      const totalsCanvas = totalsCanvasRef.current;
      if (totalsCanvas && visible.length > 0) {
        const prep = prepareCanvas(totalsCanvas);
        if (prep) {
          const { ctx, w, h } = prep;
          ctx.clearRect(0, 0, w, h);
          const padT = 18;
          const padB = 6;
          const plotW = Math.max(10, w - PAD_L - PAD_R);
          const plotH = Math.max(10, h - padT - padB);

          const askAt = (i: number) => (startIdx + i === curIdx && totalAsk !== null ? totalAsk : visible[i]!.totalAsk);
          const bidAt = (i: number) => (startIdx + i === curIdx && totalBid !== null ? totalBid : visible[i]!.totalBid);

          let minV = Infinity;
          let maxV = 1;
          for (let i = 0; i < visible.length; i++) {
            if (blindMode && startIdx + i > curIdx) continue;
            const b = visible[i]!;
            if (b.inGap) continue;
            const a = askAt(i);
            const bd = bidAt(i);
            if (a !== null) {
              minV = Math.min(minV, a);
              maxV = Math.max(maxV, a);
            }
            if (bd !== null) {
              minV = Math.min(minV, bd);
              maxV = Math.max(maxV, bd);
            }
          }
          if (!Number.isFinite(minV)) minV = 0;
          const span = Math.max(1, maxV - minV);
          minV = Math.max(0, minV - span * 0.12);
          maxV += span * 0.12;

          const xOf = (idx: number) => PAD_L + ((idx - startIdx + 0.5) / count) * plotW;
          const yOf = (v: number) => padT + (1 - (v - minV) / Math.max(1, maxV - minV)) * plotH;

          ctx.fillStyle = palette.text3;
          ctx.font = `11px ${palette.fontMono}`;
          ctx.textAlign = "left";
          ctx.fillText(formatCompactCount(maxV), PAD_L + plotW + 4, padT + 7);
          ctx.fillText(formatCompactCount(minV), PAD_L + plotW + 4, padT + plotH);

          const drawLine = (fromI: number, toI: number, get: (i: number) => number | null, color: string, alpha: number) => {
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
              const x = xOf(startIdx + i);
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

          if (pastEnd >= 0) {
            drawLine(0, pastEnd, askAt, palette.down, 1);
            drawLine(0, pastEnd, bidAt, palette.up, 1);
          }
          if (!blindMode && splitIdx !== -1) {
            drawLine(Math.max(0, pastEnd), visible.length - 1, askAt, palette.down, 0.25);
            drawLine(Math.max(0, pastEnd), visible.length - 1, bidAt, palette.up, 0.25);
          }

          const px = xOf(curMinFloat);
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
        }
      }

      drawSingleSub(
        obiCanvasRef.current,
        (i) => visible[i]!.obi,
        obiVal,
        0,
        palette.up,
        palette.down,
        (v) => `${v >= 0 ? "+" : ""}${Math.round(v)}`,
      );
      drawSingleSub(
        strengthCanvasRef.current,
        (i) => visible[i]!.strength,
        strengthVal,
        100,
        palette.up,
        palette.down,
        (v) => `${Math.round(v)}%`,
      );
      drawSingleSub(
        programCanvasRef.current,
        (i) => visible[i]!.programNetQty,
        programQty,
        0,
        palette.up,
        palette.down,
        formatCompactCount,
      );
    };

    return engine.subscribeFrame(paint);
  }, [session, engine, blindMode, bookmarks, palette, range, resizeTick]);

  const scrubFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - PAD_L) / Math.max(10, rect.width - PAD_L - PAD_R)));
    const firstMin = session.minutes[0]?.minute ?? 540;
    const { startIdx, endIdx } = visibleBounds(session, latestCursorSecRef.current, range);
    const minute = firstMin + startIdx + ratio * (endIdx - startIdx + 1);
    onScrub(minute * 60);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubFromPointer(event);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) scrubFromPointer(event);
  };

  const onPointerUp = () => {
    draggingRef.current = false;
  };

  return (
    <section className="rp-col" aria-label="1분봉 차트와 4대 보조지표">
      <div className="rp-pane-head">
        <div className="rp-pane-title">
          <span>1분봉 · VWAP · 4대 보조지표</span>
          <span ref={hmLabelRef} className="rp-muted rp-mono">09:00</span>
        </div>
        <div className="rp-seg" role="group" aria-label="차트 범위">
          <button type="button" aria-pressed={range === "all"} onClick={() => setRange("all")}>장 전체</button>
          <button type="button" aria-pressed={range === "focus"} onClick={() => setRange("focus")}>현재 ±30분</button>
        </div>
      </div>

      <div ref={rootRef} className="rp-left-stack">
        <div
          className="rp-chart-wrap"
          data-testid="replay-main-chart"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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

        <div className="rp-sub-panes" data-testid="replay-sub-indicators">
          <div className="rp-sub-pane" data-indicator="totals" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <div className="rp-sub-overlay rp-mono">
              <span className="rp-sub-name">총잔량</span>
              <span className="rp-sub-vals">
                <span className="rp-down"><i className="rp-sw-dot" data-tone="down" />매도 <b ref={totalsAskRef}>-</b></span>
                <span className="rp-up"><i className="rp-sw-dot" data-tone="up" />매수 <b ref={totalsBidRef}>-</b></span>
              </span>
            </div>
            <canvas ref={totalsCanvasRef} className="rp-canvas" />
          </div>

          <div className="rp-sub-pane" data-indicator="obi" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <div className="rp-sub-overlay rp-mono">
              <span className="rp-sub-name">호가 잔량비</span>
              <span className="rp-sub-vals">
                <b ref={obiValRef} className="rp-muted">-</b>
              </span>
            </div>
            <canvas ref={obiCanvasRef} className="rp-canvas" />
          </div>

          <div className="rp-sub-pane" data-indicator="strength" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <div className="rp-sub-overlay rp-mono">
              <span className="rp-sub-name">체결강도</span>
              <span className="rp-sub-vals">
                <b ref={strengthValRef} className="rp-muted">-</b>
              </span>
            </div>
            <canvas ref={strengthCanvasRef} className="rp-canvas" />
          </div>

          <div className="rp-sub-pane" data-indicator="program" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <div className="rp-sub-overlay rp-mono">
              <span className="rp-sub-name">프로그램 누적</span>
              <span className="rp-sub-vals">
                <b ref={programValRef} className="rp-muted">자료 없음</b>
              </span>
            </div>
            <canvas ref={programCanvasRef} className="rp-canvas" />
          </div>
        </div>
      </div>
    </section>
  );
}
