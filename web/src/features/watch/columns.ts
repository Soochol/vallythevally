import { DEFAULT_WATCH_COLUMNS, type WatchColumn } from "../../lib/watchlist";

export type WatchVariant = "desktop" | "phone";

const WIDTH: Record<WatchVariant, Record<WatchColumn, number>> = {
  desktop: { price: 76, change: 64, changeRate: 60, volume: 56 },
  phone: { price: 80, change: 64, changeRate: 64, volume: 52 },
};
const GAP = 4;
const PADDING_X = 24;
const NAME_MIN = 96;

export const columnTemplate = (variant: WatchVariant, columns: readonly WatchColumn[]) =>
  ["minmax(0,1fr)", ...columns.map((c) => `${WIDTH[variant][c]}px`)].join(" ");

const fittedWidth = (columns: readonly WatchColumn[]) => PADDING_X + NAME_MIN + columns.reduce((w, c) => w + GAP + WIDTH.desktop[c], 0);

export const desktopPanelWidth = (columns: readonly WatchColumn[]) => Math.max(fittedWidth(columns), fittedWidth(DEFAULT_WATCH_COLUMNS));
