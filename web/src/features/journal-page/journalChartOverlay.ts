import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import { toChartTime } from "../../chart/time";
import { clamp, formatPct, formatWon, parseDayUtcMs, tfStepMinutes, tradePnl } from "./journalEngine";
import type { JournalBar, JournalFill, JournalTf, JournalTrade } from "./journalTypes";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface JournalOverlayState {
  readonly trade: JournalTrade;
  readonly tf: JournalTf;
  readonly bars: readonly JournalBar[];
  readonly afterCost: boolean;
  readonly highlightFill: JournalFill | null;
}

export function findBarIndexForFill(bars: readonly JournalBar[], fill: JournalFill, tf: JournalTf): number {
  if (bars.length === 0) return -1;
  if (tf === "D") {
    const exact = bars.findIndex((b) => b.day === fill.day);
    if (exact >= 0) return exact;
    const targetMs = parseDayUtcMs(fill.day);
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < bars.length; i += 1) {
      const diff = Math.abs(parseDayUtcMs(bars[i]!.day) - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }
  const step = tfStepMinutes(tf);
  const bucketMin = Math.floor(fill.minutes / step) * step;
  const exact = bars.findIndex((b) => b.day === fill.day && b.minutes === bucketMin);
  if (exact >= 0) return exact;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i]!;
    if (b.day !== fill.day) continue;
    const dist = Math.abs(b.minutes - fill.minutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

interface OverlayPalette {
  readonly up: string;
  readonly down: string;
  readonly text: string;
  readonly text2: string;
  readonly surface: string;
  readonly raised: string;
  readonly cloudUp: string;
  readonly cloudDown: string;
  readonly fontFamily: string;
}

function readOverlayPalette(): OverlayPalette {
  const styles = getComputedStyle(document.documentElement);
  const cssVar = (name: string) => styles.getPropertyValue(name).trim();
  return {
    up: cssVar("--up") || "#ef4444",
    down: cssVar("--down") || "#3b82f6",
    text: cssVar("--text") || "#e5e7eb",
    text2: cssVar("--text-2") || "#9ca3af",
    surface: cssVar("--surface") || "#111827",
    raised: cssVar("--raised") || "#1f2937",
    cloudUp: cssVar("--cloud-up") || "rgba(239, 68, 68, 0.1)",
    cloudDown: cssVar("--cloud-down") || "rgba(59, 130, 246, 0.1)",
    fontFamily: cssVar("--font-sans") || "system-ui, sans-serif",
  };
}

export class JournalTradeOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private state: JournalOverlayState | null = null;
  private palette: OverlayPalette = readOverlayPalette();
  private readonly views: readonly IPrimitivePaneView[];

  constructor() {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => this.draw(target),
    };
    this.views = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series as ISeriesApi<"Candlestick">;
    this.requestUpdate = requestUpdate;
    this.palette = readOverlayPalette();
    this.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  setState(next: JournalOverlayState): void {
    this.state = next;
    this.requestUpdate?.();
  }

  refreshTheme(): void {
    this.palette = readOverlayPalette();
    this.requestUpdate?.();
  }

  private draw(target: Target): void {
    const state = this.state;
    const chart = this.chart;
    const series = this.series;
    if (state === null || chart === null || series === null || state.bars.length === 0) return;

    const { trade, tf, bars, afterCost, highlightFill } = state;
    const timeScale = chart.timeScale();
    const firstBuy = trade.buys[0];
    const lastSell = trade.sells[trade.sells.length - 1];
    const entryIdx = firstBuy ? findBarIndexForFill(bars, firstBuy, tf) : -1;
    const exitIdx = lastSell ? findBarIndexForFill(bars, lastSell, tf) : -1;
    const highlightIdx = highlightFill ? findBarIndexForFill(bars, highlightFill, tf) : -1;
    const barSpacing = timeScale.options().barSpacing;
    const palette = this.palette;

    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: rx, verticalPixelRatio: ry }) => {
      const W = bitmapSize.width;
      const H = bitmapSize.height;
      const toX = (idx: number): number | null => {
        const bar = bars[idx];
        if (bar === undefined) return null;
        const coord = timeScale.timeToCoordinate(toChartTime(bar.t));
        return coord === null ? null : coord * rx;
      };
      const toY = (price: number): number | null => {
        const coord = series.priceToCoordinate(price);
        return coord === null ? null : coord * ry;
      };
      const setFont = (px: number, weight = 500) => {
        ctx.font = `${weight} ${Math.round(px * ry)}px ${palette.fontFamily}`;
      };

      ctx.save();
      const bw = Math.max(4, barSpacing * rx);
      const isProfit = tradePnl(trade, afterCost) >= 0;

      if (entryIdx >= 0 && exitIdx >= 0) {
        const loIdx = Math.min(entryIdx, exitIdx);
        const hiIdx = Math.max(entryIdx, exitIdx);
        const xLo = toX(loIdx);
        const xHi = toX(hiIdx);
        if (xLo !== null || xHi !== null) {
          const left = xLo !== null ? xLo - bw / 2 : 0;
          const right = xHi !== null ? xHi + bw / 2 : W;
          if (right > 0 && left < W) {
            ctx.fillStyle = isProfit ? palette.cloudUp : palette.cloudDown;
            ctx.fillRect(Math.max(0, left), 0, Math.max(bw, Math.min(W, right) - Math.max(0, left)), H);
          }
        }
      }

      if (highlightIdx >= 0) {
        const hx = toX(highlightIdx);
        if (hx !== null && hx >= -bw && hx <= W + bw) {
          ctx.fillStyle = palette.raised;
          ctx.globalAlpha = 0.65;
          const stripW = Math.max(bw * 1.25, 12 * rx);
          ctx.fillRect(hx - stripW / 2, 0, stripW, H);
          ctx.globalAlpha = 1;
        }
      }

      const avgY = toY(trade.avgBuy);
      if (avgY !== null && avgY >= 0 && avgY <= H) {
        const yLine = Math.round(avgY) + 0.5;
        const loIdx = entryIdx >= 0 && exitIdx >= 0 ? Math.min(entryIdx, exitIdx) : -1;
        const hiIdx = entryIdx >= 0 && exitIdx >= 0 ? Math.max(entryIdx, exitIdx) : -1;
        const hx0 = loIdx >= 0 ? toX(loIdx) : null;
        const hx1 = hiIdx >= 0 ? toX(hiIdx) : null;
        ctx.strokeStyle = palette.text2;
        ctx.lineWidth = Math.max(1, ry);
        ctx.setLineDash([4 * rx, 4 * rx]);
        if (hx0 !== null && hx1 !== null) {
          const left = hx0 - bw / 2;
          const right = hx1 + bw / 2;
          ctx.beginPath();
          ctx.moveTo(left, yLine);
          ctx.lineTo(right, yLine);
          ctx.stroke();
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.moveTo(right, yLine);
          ctx.lineTo(W, yLine);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.moveTo(0, yLine);
          ctx.lineTo(W, yLine);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash([]);

        setFont(10.5, 600);
        const tag = `평단 ${formatWon(trade.avgBuy, false)}`;
        const padX = 6 * rx;
        const boxH = 18 * ry;
        const boxW = ctx.measureText(tag).width + padX * 2;
        const bx = Math.max(6 * rx, W - boxW - 8 * rx);
        const by = clamp(yLine - boxH / 2, 4 * ry, H - boxH - 4 * ry);
        ctx.fillStyle = palette.raised;
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.fillStyle = palette.text;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(tag, bx + padX, by + boxH / 2);
      }

      const stackB = new Map<number, number>();
      const stackS = new Map<number, number>();
      const halfTick = Math.max(bw * 0.42, 6 * rx);
      const marks: { x: number; y: number }[] = [];

      const drawFill = (fill: JournalFill, isSell: boolean, seq: number, multi: boolean) => {
        const idx = findBarIndexForFill(bars, fill, tf);
        if (idx < 0) return;
        const bar = bars[idx]!;
        const x = toX(idx);
        const yp = toY(fill.price);
        const anchorY = toY(isSell ? bar.h : bar.l);
        if (x === null || yp === null || anchorY === null) return;
        if (x < -bw * 2 || x > W + bw * 2) return;

        const map = isSell ? stackS : stackB;
        const k = map.get(idx) ?? 0;
        map.set(idx, k + 1);

        ctx.strokeStyle = ctx.fillStyle = isSell ? palette.down : palette.up;
        ctx.lineWidth = Math.max(1.5, 1.8 * ry);
        ctx.beginPath();
        ctx.moveTo(x - halfTick, Math.round(yp) + 0.5);
        ctx.lineTo(x + halfTick, Math.round(yp) + 0.5);
        ctx.stroke();

        const dir = isSell ? -1 : 1;
        const gapY = (multi ? 13 : 11) * ry;
        const y = isSell ? anchorY - 10 * ry - k * gapY : anchorY + 10 * ry + k * gapY;
        ctx.beginPath();
        ctx.moveTo(x, y - 4.5 * ry * dir);
        ctx.lineTo(x - 5 * rx, y + 4 * ry * dir);
        ctx.lineTo(x + 5 * rx, y + 4 * ry * dir);
        ctx.closePath();
        ctx.fill();

        if (multi) {
          setFont(10.5, 700);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(String(seq), x + 7 * rx, y);
        }
        marks.push({ x, y });
      };

      trade.buys.forEach((f, i) => drawFill(f, false, i + 1, trade.buys.length > 1));
      trade.sells.forEach((f, i) => drawFill(f, true, i + 1, trade.sells.length > 1));

      if (entryIdx >= 0 && exitIdx >= 0 && Math.max(entryIdx, exitIdx) > Math.min(entryIdx, exitIdx)) {
        const holdLo = Math.min(entryIdx, exitIdx);
        const holdHi = Math.max(entryIdx, exitIdx);
        let hiBar = holdLo;
        let loBar = holdLo;
        for (let i = holdLo; i <= holdHi; i += 1) {
          if (bars[i]!.h > bars[hiBar]!.h) hiBar = i;
          if (bars[i]!.l < bars[loBar]!.l) loBar = i;
        }
        const clearY = (x: number, y: number, dir: -1 | 1) => {
          let outY = y;
          for (const m of marks) {
            if (Math.abs(m.x - x) < 48 * rx) {
              outY = dir < 0 ? Math.min(outY, m.y - 12 * ry) : Math.max(outY, m.y + 12 * ry);
            }
          }
          return outY;
        };
        const halo = (txt: string, x: number, y: number, color: string) => {
          ctx.strokeStyle = palette.surface;
          ctx.lineWidth = 3.5 * ry;
          ctx.lineJoin = "round";
          ctx.strokeText(txt, x, y);
          ctx.fillStyle = color;
          ctx.fillText(txt, x, y);
        };
        setFont(10.5, 600);
        ctx.textAlign = "center";
        const xH = toX(hiBar);
        const yH = toY(bars[hiBar]!.h);
        if (xH !== null && yH !== null && xH >= 0 && xH <= W) {
          const cx = clamp(xH, 38 * rx, W - 38 * rx);
          ctx.textBaseline = "bottom";
          halo(`최고 ${formatPct(trade.mfe)}`, cx, clearY(cx, yH - 6 * ry, -1), palette.up);
        }
        const xL = toX(loBar);
        const yL = toY(bars[loBar]!.l);
        if (xL !== null && yL !== null && xL >= 0 && xL <= W) {
          const cx = clamp(xL, 38 * rx, W - 38 * rx);
          ctx.textBaseline = "top";
          halo(`최저 ${formatPct(trade.mae)}`, cx, clearY(cx, yL + 6 * ry, 1), palette.down);
        }
      }

      ctx.restore();
    });
  }
}
