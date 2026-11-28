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
import { clamp, formatWon, parseDayUtcMs, tfStepMinutes, tradePnl } from "./journalEngine";
import type { JournalBar, JournalFill, JournalTf, JournalTrade } from "./journalTypes";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface JournalOverlayState {
  readonly trades: readonly JournalTrade[];
  readonly tf: JournalTf;
  readonly bars: readonly JournalBar[];
  readonly afterCost: boolean;
  readonly highlightFill: JournalFill | null;
}

export interface BarFillCluster {
  readonly barIdx: number;
  readonly side: "buy" | "sell";
  readonly count: number;
  readonly totalQty: number;
  readonly vwap: number;
  readonly fills: readonly JournalFill[];
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

export function buildBarFillClusters(
  bars: readonly JournalBar[],
  trades: readonly JournalTrade[],
  tf: JournalTf,
): readonly BarFillCluster[] {
  const buckets = new Map<string, { barIdx: number; side: "buy" | "sell"; fills: JournalFill[] }>();
  const push = (fill: JournalFill) => {
    const barIdx = findBarIndexForFill(bars, fill, tf);
    if (barIdx < 0) return;
    const key = `${barIdx}|${fill.side}`;
    const existing = buckets.get(key);
    if (existing !== undefined) existing.fills.push(fill);
    else buckets.set(key, { barIdx, side: fill.side, fills: [fill] });
  };
  for (const trade of trades) {
    for (const f of trade.buys) push(f);
    for (const f of trade.sells) push(f);
  }
  const out: BarFillCluster[] = [];
  for (const b of buckets.values()) {
    let totalQty = 0;
    let weightedSum = 0;
    for (const f of b.fills) {
      totalQty += f.qty;
      weightedSum += f.price * f.qty;
    }
    out.push({
      barIdx: b.barIdx,
      side: b.side,
      count: b.fills.length,
      totalQty,
      vwap: totalQty > 0 ? weightedSum / totalQty : b.fills[0]!.price,
      fills: b.fills,
    });
  }
  out.sort((a, b) => a.barIdx - b.barIdx || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1));
  return out;
}

interface OverlayPalette {
  readonly up: string;
  readonly down: string;
  readonly upSoft: string;
  readonly downSoft: string;
  readonly text: string;
  readonly text2: string;
  readonly onData: string;
  readonly raised: string;
  readonly cloudUp: string;
  readonly cloudDown: string;
  readonly fontFamily: string;
}

function readOverlayPalette(): OverlayPalette {
  const styles = getComputedStyle(document.documentElement);
  const cssVar = (name: string) => styles.getPropertyValue(name).trim();
  return {
    up: cssVar("--up"),
    down: cssVar("--down"),
    upSoft: cssVar("--up-soft"),
    downSoft: cssVar("--down-soft"),
    text: cssVar("--text"),
    text2: cssVar("--text-2"),
    onData: cssVar("--on-data"),
    raised: cssVar("--raised"),
    cloudUp: cssVar("--cloud-up"),
    cloudDown: cssVar("--cloud-down"),
    fontFamily: cssVar("--font-sans") || "system-ui, sans-serif",
  };
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
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
    if (state === null || chart === null || series === null || state.bars.length === 0 || state.trades.length === 0) return;

    const { trades, tf, bars, afterCost, highlightFill } = state;
    const timeScale = chart.timeScale();
    const barSpacing = timeScale.options().barSpacing;
    const palette = this.palette;
    const clusters = buildBarFillClusters(bars, trades, tf);
    const hasSpotlight = highlightFill !== null;

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
      const setFont = (px: number, weight = 600) => {
        ctx.font = `${weight} ${Math.round(px * ry)}px ${palette.fontFamily}`;
      };

      ctx.save();
      const bw = Math.max(4, barSpacing * rx);
      const multiTrade = trades.length > 1;

      trades.forEach((trade, tradeIdx) => {
        const firstBuy = trade.buys[0];
        const lastSell = trade.sells[trade.sells.length - 1];
        const entryIdx = firstBuy ? findBarIndexForFill(bars, firstBuy, tf) : -1;
        const exitIdx = lastSell ? findBarIndexForFill(bars, lastSell, tf) : -1;
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

              if (multiTrade) {
                setFont(10, 700);
                const badgeText = `${tradeIdx + 1}회`;
                const pw = ctx.measureText(badgeText).width + 10 * rx;
                const ph = 16 * ry;
                const px = clamp(left + 4 * rx, 4 * rx, W - pw - 4 * rx);
                const py = 30 * ry;
                ctx.fillStyle = isProfit ? palette.upSoft : palette.downSoft;
                fillRoundedRect(ctx, px, py, pw, ph, 4 * rx);
                ctx.fillStyle = isProfit ? palette.up : palette.down;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(badgeText, px + pw / 2, py + ph / 2);
              }
            }
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
            ctx.globalAlpha = multiTrade ? 0.65 : 1;
            ctx.beginPath();
            ctx.moveTo(left, yLine);
            ctx.lineTo(right, yLine);
            ctx.stroke();
            if (!multiTrade) {
              ctx.globalAlpha = 0.3;
              ctx.beginPath();
              ctx.moveTo(right, yLine);
              ctx.lineTo(W, yLine);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          } else if (!multiTrade) {
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(0, yLine);
            ctx.lineTo(W, yLine);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          ctx.setLineDash([]);

          if (!multiTrade) {
            setFont(10.5, 600);
            const tag = `평단 ${formatWon(trade.avgBuy, false)}`;
            const padX = 6 * rx;
            const boxH = 18 * ry;
            const boxW = ctx.measureText(tag).width + padX * 2;
            const bx = Math.max(6 * rx, W - boxW - 8 * rx);
            const by = clamp(yLine - boxH / 2, 4 * ry, H - boxH - 4 * ry);
            ctx.fillStyle = palette.raised;
            fillRoundedRect(ctx, bx, by, boxW, boxH, 4 * rx);
            ctx.fillStyle = palette.text;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(tag, bx + padX, by + boxH / 2);
          }
        }
      });

      const dotOuterY = new Map<string, number>();
      const baseAlpha = hasSpotlight ? 0.22 : 1;

      for (const cl of clusters) {
        const bar = bars[cl.barIdx]!;
        const x = toX(cl.barIdx);
        const isSell = cl.side === "sell";
        const anchorY = toY(isSell ? bar.h : bar.l);
        if (x === null || anchorY === null) continue;
        if (x < -bw * 2 || x > W + bw * 2) continue;

        const r = clamp(2.4 + Math.min(cl.count - 1, 5) * 0.65, 2.4, 5.65) * rx;
        const dotY = isSell
          ? clamp(anchorY - (7 * ry + r), 8 * ry, H - 8 * ry)
          : clamp(anchorY + (7 * ry + r), 8 * ry, H - 8 * ry);
        const col = isSell ? palette.down : palette.up;

        ctx.fillStyle = col;
        ctx.globalAlpha = baseAlpha * 0.25;
        ctx.beginPath();
        ctx.arc(x, dotY, r + 2.4 * rx, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = baseAlpha * 0.92;
        ctx.beginPath();
        ctx.arc(x, dotY, r, 0, Math.PI * 2);
        ctx.fill();

        dotOuterY.set(`${cl.barIdx}|${cl.side}`, isSell ? dotY - r : dotY + r);
      }

      ctx.globalAlpha = hasSpotlight ? 0.3 : 1;
      const drawAnchorPill = (barIdx: number, isSell: boolean, label: string) => {
        const bar = bars[barIdx];
        if (bar === undefined) return;
        const x = toX(barIdx);
        const rawY = toY(isSell ? bar.h : bar.l);
        if (x === null || rawY === null) return;
        if (x < -bw * 2 || x > W + bw * 2) return;

        setFont(10, 700);
        const padX = 5 * rx;
        const ph = 16 * ry;
        const pw = ctx.measureText(label).width + padX * 2;
        const edge = dotOuterY.get(`${barIdx}|${isSell ? "sell" : "buy"}`);
        const baseY = edge !== undefined ? edge : rawY;
        const py = isSell
          ? clamp(baseY - ph - 5 * ry, 4 * ry, H - ph - 4 * ry)
          : clamp(baseY + 5 * ry, 4 * ry, H - ph - 4 * ry);
        const px = clamp(x - pw / 2, 4 * rx, W - pw - 4 * rx);

        ctx.fillStyle = isSell ? palette.down : palette.up;
        fillRoundedRect(ctx, px, py, pw, ph, 4 * rx);
        ctx.fillStyle = palette.onData;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + pw / 2, py + ph / 2);
      };

      trades.forEach((trade, tradeIdx) => {
        const firstBuy = trade.buys[0];
        const lastSell = trade.sells[trade.sells.length - 1];
        const entryIdx = firstBuy ? findBarIndexForFill(bars, firstBuy, tf) : -1;
        const exitIdx = lastSell ? findBarIndexForFill(bars, lastSell, tf) : -1;
        const buyLabel = multiTrade
          ? `${tradeIdx + 1} 진입`
          : trade.buys.length > 1
            ? `진입 ${trade.buys.length}`
            : "진입";
        const sellLabel = multiTrade
          ? `${tradeIdx + 1} 청산`
          : trade.sells.length > 1
            ? `청산 ${trade.sells.length}`
            : "청산";
        if (entryIdx >= 0) drawAnchorPill(entryIdx, false, buyLabel);
        if (exitIdx >= 0) drawAnchorPill(exitIdx, true, sellLabel);
      });

      ctx.globalAlpha = 1;

      if (highlightFill !== null) {
        const hIdx = findBarIndexForFill(bars, highlightFill, tf);
        if (hIdx >= 0) {
          const hx = toX(hIdx);
          const hy = toY(highlightFill.price);
          if (hx !== null && hy !== null && hx >= -bw && hx <= W + bw) {
            const isSell = highlightFill.side === "sell";
            const col = isSell ? palette.down : palette.up;

            ctx.strokeStyle = col;
            ctx.lineWidth = Math.max(1, ry);
            ctx.globalAlpha = 0.65;
            ctx.setLineDash([3 * rx, 3 * rx]);
            ctx.beginPath();
            ctx.moveTo(Math.round(hx) + 0.5, 0);
            ctx.lineTo(Math.round(hx) + 0.5, H);
            ctx.moveTo(0, Math.round(hy) + 0.5);
            ctx.lineTo(W, Math.round(hy) + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = isSell ? palette.downSoft : palette.upSoft;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(hx, hy, 11 * rx, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = col;
            ctx.lineWidth = Math.max(2, 2.2 * ry);
            ctx.beginPath();
            ctx.arc(hx, hy, 6 * rx, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = palette.onData;
            ctx.beginPath();
            ctx.arc(hx, hy, 2.4 * rx, 0, Math.PI * 2);
            ctx.fill();

            setFont(10.5, 700);
            const tag = `${isSell ? "▼" : "▲"} ${formatWon(highlightFill.price, false)} × ${highlightFill.qty.toLocaleString("ko-KR")}주 · ${highlightFill.timeLabel}`;
            const padX = 7 * rx;
            const ph = 20 * ry;
            const pw = ctx.measureText(tag).width + padX * 2;
            const px = clamp(hx - pw / 2, 6 * rx, W - pw - 6 * rx);
            const py = hy > 38 * ry ? hy - ph - 12 * ry : clamp(hy + 14 * ry, 4 * ry, H - ph - 4 * ry);
            ctx.fillStyle = col;
            fillRoundedRect(ctx, px, py, pw, ph, 5 * rx);
            ctx.fillStyle = palette.onData;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(tag, px + padX, py + ph / 2);
          }
        }
      }

      ctx.restore();
    });
  }
}
