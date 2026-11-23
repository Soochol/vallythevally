import type { WatchColumn } from "../../lib/watchlist";
import { LIST_COLUMN_GAP, LIST_PRICE_WIDTH, LIST_RATE_WIDTH } from "../list/listRow";

export type WatchVariant = "desktop" | "phone";

const WIDTH: Record<WatchVariant, Record<WatchColumn, number>> = {
  desktop: { price: LIST_PRICE_WIDTH, change: 64, changeRate: LIST_RATE_WIDTH, volume: 56 },
  phone: { price: 80, change: 64, changeRate: LIST_RATE_WIDTH, volume: 52 },
};
const PADDING_X = 24;
const NAME_MIN = 96;
const NAME_MAX = 220;

const KEEP_ORDER: readonly WatchColumn[] = ["price", "changeRate", "change", "volume"];

export const columnTemplate = (variant: WatchVariant, columns: readonly WatchColumn[]) =>
  [variant === "desktop" ? `minmax(${NAME_MIN}px, ${NAME_MAX}px)` : "minmax(0,1fr)", ...columns.map((c) => `${WIDTH[variant][c]}px`)].join(" ");

export const fittedWidth = (columns: readonly WatchColumn[]) => PADDING_X + NAME_MIN + columns.reduce((w, c) => w + LIST_COLUMN_GAP + WIDTH.desktop[c], 0);

export function fitColumns(columns: readonly WatchColumn[], width: number): readonly WatchColumn[] {
  const dropOrder = [...columns].sort((a, b) => KEEP_ORDER.indexOf(b) - KEEP_ORDER.indexOf(a));
  const dropped = new Set<WatchColumn>();
  for (const column of dropOrder) {
    if (dropped.size === columns.length - 1) break;
    if (fittedWidth(columns.filter((c) => !dropped.has(c))) <= width) break;
    dropped.add(column);
  }
  return dropped.size === 0 ? columns : columns.filter((c) => !dropped.has(c));
}
