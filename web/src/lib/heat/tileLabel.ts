export type TileLabel = "full" | "rate" | "none";

const FULL_MIN_WIDTH = 64;
const FULL_MIN_HEIGHT = 34;
const RATE_MIN_WIDTH = 44;
const RATE_MIN_HEIGHT = 20;

export function tileLabel(widthPx: number, heightPx: number): TileLabel {
  if (widthPx >= FULL_MIN_WIDTH && heightPx >= FULL_MIN_HEIGHT) return "full";
  if (widthPx >= RATE_MIN_WIDTH && heightPx >= RATE_MIN_HEIGHT) return "rate";
  return "none";
}

const NAME_TWO_LINES_MIN_HEIGHT = 48;

export function nameLines(heightPx: number): 1 | 2 {
  return heightPx >= NAME_TWO_LINES_MIN_HEIGHT ? 2 : 1;
}
