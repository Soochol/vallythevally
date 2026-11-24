import type { FeedProgramRow } from "../../api/generated/FeedProgramRow";
import type { ProgramTradePoint } from "../../api/generated/ProgramTradePoint";
import { formatKstClockSeconds } from "../../chart/time";

const WON_PER_MILLION_WON = 1_000_000;
const MILLION_WON_PER_EOK = 100;

export const eokFromMillionWon = (millionWon: number): number => millionWon / MILLION_WON_PER_EOK;

const eokFormat = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatEokAmount = (eok: number): string => `${eokFormat.format(eok)}억원`;

export const millionWonFromWon = (won: number): number => won / WON_PER_MILLION_WON;

export type ProgramSource = "history" | "live";

export interface ProgramRow {
  readonly key: string;
  readonly source: ProgramSource;
  readonly time: string;
  readonly price: number | null;
  readonly netQty: number;
  readonly netQtyChange: number;
  readonly netAmountMillionWon: number;
  readonly buyQty: number;
  readonly sellQty: number;
}

export type ProgramLine = { readonly kind: "row"; readonly row: ProgramRow } | { readonly kind: "gap"; readonly key: string; readonly time: string };

export function liveRow(row: FeedProgramRow, sequence: number): ProgramRow {
  return {
    key: `live-${sequence}`,
    source: "live",
    time: formatKstClockSeconds(row.t),
    price: row.price,
    netQty: row.netQty,
    netQtyChange: row.netQtyChange,
    netAmountMillionWon: row.netAmount,
    buyQty: row.buyQty,
    sellQty: row.sellQty,
  };
}

export function historyRows(points: readonly ProgramTradePoint[]): ProgramRow[] {
  const chronological = [...points].sort((a, b) => a.time.localeCompare(b.time));
  let previousNet = 0;
  return chronological.map((point, index) => {
    const row: ProgramRow = {
      key: `history-${index}`,
      source: "history",
      time: point.time,
      price: point.price,
      netQty: point.netQuantity,
      netQtyChange: point.netQuantity - previousNet,
      netAmountMillionWon: millionWonFromWon(point.netAmount),
      buyQty: point.buyQuantity,
      sellQty: point.sellQuantity,
    };
    previousNet = point.netQuantity;
    return row;
  });
}

export function joinHistoryAndLive(history: readonly ProgramRow[], live: readonly ProgramLine[]): ProgramLine[] {
  const firstLive = live.find((line) => line.kind === "row");
  const kept = firstLive ? history.filter((row) => row.time < firstLive.row.time) : history;
  return [...kept.map((row): ProgramLine => ({ kind: "row", row })), ...live];
}

export const rowsOf = (lines: readonly ProgramLine[]): ProgramRow[] => lines.flatMap((line) => (line.kind === "row" ? [line.row] : []));

export const nonZeroChangeLines = (lines: readonly ProgramLine[]): ProgramLine[] =>
  lines.filter((line) => line.kind === "gap" || line.row.netQtyChange !== 0);

const TOP_SHARE = 0.1;

export function boldKeys(visible: readonly ProgramRow[]): ReadonlySet<string> {
  const magnitudes = visible.map((row) => Math.abs(row.netQtyChange)).sort((a, b) => b - a);
  if (magnitudes.length === 0) return new Set();
  const cutoff = magnitudes[Math.ceil(magnitudes.length * TOP_SHARE) - 1]!;
  if (cutoff === 0) return new Set();
  return new Set(visible.filter((row) => Math.abs(row.netQtyChange) >= cutoff).map((row) => row.key));
}

export type ColumnWidths = readonly [number, number, number];

export function widestSoFar(previous: ColumnWidths, texts: readonly [string, string, string]): ColumnWidths {
  return [Math.max(previous[0], texts[0].length), Math.max(previous[1], texts[1].length), Math.max(previous[2], texts[2].length)];
}

export function sparklinePoints(netQtys: readonly number[], width: number, height: number): string {
  if (netQtys.length < 2) return "";
  const low = Math.min(...netQtys);
  const span = Math.max(...netQtys) - low || 1;
  return netQtys.map((value, index) => `${((index / (netQtys.length - 1)) * width).toFixed(2)},${(height - ((value - low) / span) * height).toFixed(2)}`).join(" ");
}

export const isNoProgramData = (history: readonly ProgramRow[], live: readonly ProgramLine[]): boolean => history.length === 0 && rowsOf(live).length === 0;
