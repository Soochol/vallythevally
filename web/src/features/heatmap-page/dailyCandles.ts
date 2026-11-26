import type { Bar } from "../../api/generated/Bar";
import type { BarsPage } from "../../api/generated/BarsPage";

export const DAILY_CANDLE_LIMIT = 15;
export const CANDLE_STRIP_WIDTH = 72;
export const CANDLE_STRIP_HEIGHT = 24;

export type CandleSide = "up" | "down" | "flat";

export interface CandleShape {
  readonly t: number;
  readonly x: number;
  readonly wickTop: number;
  readonly wickBottom: number;
  readonly bodyX: number;
  readonly bodyY: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly side: CandleSide;
}

const PAD_Y = 2;
const MIN_BODY_HEIGHT = 1.2;
const BODY_FILL_RATIO = 0.62;

export function recentDailyBars(page: BarsPage | undefined, livePrice: number | null, limit = DAILY_CANDLE_LIMIT): Bar[] {
  if (!page) return [];
  const merged = page.current && page.bars[page.bars.length - 1]?.t !== page.current.t ? [...page.bars, page.current] : [...page.bars];
  const recent = merged.slice(-limit);
  if (recent.length === 0 || livePrice === null || !Number.isFinite(livePrice) || livePrice <= 0) return recent;
  const last = recent[recent.length - 1]!;
  recent[recent.length - 1] = {
    ...last,
    c: livePrice,
    h: Math.max(last.h, livePrice),
    l: Math.min(last.l, livePrice),
  };
  return recent;
}

export function candleShapes(bars: readonly Bar[], width = CANDLE_STRIP_WIDTH, height = CANDLE_STRIP_HEIGHT, slots = DAILY_CANDLE_LIMIT): CandleShape[] {
  if (bars.length === 0 || width <= 0 || height <= 0) return [];
  const count = Math.max(slots, bars.length);
  const step = width / count;
  const bodyWidth = Math.max(1.6, Math.min(3.2, step * BODY_FILL_RATIO));
  const offset = count - bars.length;

  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (const bar of bars) {
    if (bar.l < minLow) minLow = bar.l;
    if (bar.h > maxHigh) maxHigh = bar.h;
  }
  const span = maxHigh - minLow;
  const usableHeight = Math.max(1, height - PAD_Y * 2);
  const yOf = (price: number) => (span <= 0 ? height / 2 : PAD_Y + ((maxHigh - price) / span) * usableHeight);

  return bars.map((bar, index) => {
    const x = (offset + index + 0.5) * step;
    const wickTop = yOf(bar.h);
    const wickBottom = yOf(bar.l);
    const openY = yOf(bar.o);
    const closeY = yOf(bar.c);
    const rawBodyY = Math.min(openY, closeY);
    const rawBodyHeight = Math.abs(closeY - openY);
    const bodyHeight = Math.max(MIN_BODY_HEIGHT, rawBodyHeight);
    const bodyY = rawBodyHeight < MIN_BODY_HEIGHT ? rawBodyY - (MIN_BODY_HEIGHT - rawBodyHeight) / 2 : rawBodyY;
    const side: CandleSide = bar.c > bar.o ? "up" : bar.c < bar.o ? "down" : "flat";
    return { t: bar.t, x, wickTop, wickBottom, bodyX: x - bodyWidth / 2, bodyY, bodyWidth, bodyHeight, side };
  });
}
