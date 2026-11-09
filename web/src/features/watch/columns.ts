import type { WatchColumn } from "../../lib/watchlist";

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

/** 데스크톱 패널 폭. 기본 열(현재가, 등락률)에서 264px이고, 열을 더하면 이름 칸이 줄지 않게 넓힌다. */
export const desktopPanelWidth = (columns: readonly WatchColumn[]) =>
  PADDING_X + NAME_MIN + columns.reduce((w, c) => w + GAP + WIDTH.desktop[c], 0);
