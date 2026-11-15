import type { WatchColumn } from "../../lib/watchlist";
import { LIST_PRICE_WIDTH, LIST_RATE_WIDTH } from "../list/listRow";

export type WatchVariant = "desktop" | "phone";

const WIDTH: Record<WatchVariant, Record<WatchColumn, number>> = {
  desktop: { price: LIST_PRICE_WIDTH, change: 64, changeRate: LIST_RATE_WIDTH, volume: 56 },
  phone: { price: 80, change: 64, changeRate: 64, volume: 52 },
};
const GAP = 4;
const PADDING_X = 24;
const NAME_MIN = 96;

export const columnTemplate = (variant: WatchVariant, columns: readonly WatchColumn[]) =>
  ["minmax(0,1fr)", ...columns.map((c) => `${WIDTH[variant][c]}px`)].join(" ");

export const fittedWidth = (columns: readonly WatchColumn[]) => PADDING_X + NAME_MIN + columns.reduce((w, c) => w + GAP + WIDTH.desktop[c], 0);

export function fitColumns(columns: readonly WatchColumn[], width: number): readonly WatchColumn[] {
  let count = columns.length;
  while (count > 1 && fittedWidth(columns.slice(0, count)) > width) count -= 1;
  return count === columns.length ? columns : columns.slice(0, count);
}
