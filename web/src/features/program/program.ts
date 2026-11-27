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

export function historyRows(points: readonly ProgramTradePoint[], truncated = false): ProgramRow[] {
  const chronological = [...points].sort((a, b) => a.time.localeCompare(b.time));
  let previousNet = 0;
  return chronological.map((point, index) => {
    const netQtyChange = truncated && index === 0 ? 0 : point.netQuantity - previousNet;
    const row: ProgramRow = {
      key: `history-${index}`,
      source: "history",
      time: point.time,
      price: point.price,
      netQty: point.netQuantity,
      netQtyChange,
      netAmountMillionWon: millionWonFromWon(point.netAmount),
      buyQty: point.buyQuantity,
      sellQty: point.sellQuantity,
    };
    previousNet = point.netQuantity;
    return row;
  });
}

export function keepProgramHistory(
  history: readonly ProgramRow[],
  firstLiveTime: string | null,
  isFallbackHistory: boolean,
): readonly ProgramRow[] {
  if (firstLiveTime === null) return history;
  if (isFallbackHistory) return [];
  return history.filter((row) => row.time < firstLiveTime);
}

export function joinHistoryAndLive(
  history: readonly ProgramRow[],
  live: readonly ProgramLine[],
  isFallbackHistory = false,
): ProgramLine[] {
  const firstLive = live.find((line) => line.kind === "row");
  const kept = keepProgramHistory(history, firstLive?.row.time ?? null, isFallbackHistory);
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

export const MAX_LIVE_PROGRAM_LINES = 600;
export const MAX_PROGRAM_TREND_POINTS = 400;

export interface ProgramLiveState {
  readonly firstLiveTime: string | null;
  readonly lastTickSeconds: number | null;
  readonly latest: ProgramRow | null;
  readonly lines: readonly ProgramLine[];
  readonly trend: readonly number[];
  readonly sequence: number;
}

export const EMPTY_PROGRAM_LIVE: ProgramLiveState = {
  firstLiveTime: null,
  lastTickSeconds: null,
  latest: null,
  lines: [],
  trend: [],
  sequence: 0,
};

export function isHistoryFresherThanLive(
  history: readonly ProgramRow[],
  live: ProgramLiveState,
  isFallbackHistory: boolean,
): boolean {
  if (isFallbackHistory || live.latest === null || history.length === 0) return false;
  return history.at(-1)!.time > live.latest.time;
}

export type ProgramLiveAction = { readonly type: "row"; readonly row: FeedProgramRow } | { readonly type: "gap"; readonly at: number };

function downsampleMinMax(values: readonly number[], maxPoints: number): number[] {
  const n = values.length;
  if (n <= maxPoints || maxPoints < 4) return [...values];
  const interior = n - 2;
  const buckets = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const out: number[] = [values[0]!];
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor((b * interior) / buckets);
    const end = 1 + Math.floor(((b + 1) * interior) / buckets);
    if (start >= end) continue;
    let minVal = values[start]!;
    let maxVal = minVal;
    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const value = values[i]!;
      if (value < minVal) { minVal = value; minIdx = i; }
      if (value > maxVal) { maxVal = value; maxIdx = i; }
    }
    if (minIdx === maxIdx) out.push(minVal);
    else if (minIdx < maxIdx) out.push(minVal, maxVal);
    else out.push(maxVal, minVal);
  }
  out.push(values[n - 1]!);
  return out;
}

export function reduceProgramLive(state: ProgramLiveState, action: ProgramLiveAction): ProgramLiveState {
  if (action.type === "gap") {
    if (state.lines.at(-1)?.kind === "gap") return state;
    const gap: ProgramLine = { kind: "gap", key: `gap-${state.sequence}`, time: formatKstClockSeconds(action.at) };
    const nextLines = state.lines.length >= MAX_LIVE_PROGRAM_LINES
      ? [...state.lines.slice(-(MAX_LIVE_PROGRAM_LINES - 1)), gap]
      : [...state.lines, gap];
    return { ...state, lines: nextLines, sequence: state.sequence + 1 };
  }
  if (state.lastTickSeconds !== null) {
    if (action.row.t < state.lastTickSeconds) return state;
    if (
      action.row.t === state.lastTickSeconds
      && state.latest !== null
      && state.latest.netQty === action.row.netQty
      && state.latest.netQtyChange === action.row.netQtyChange
      && state.latest.buyQty === action.row.buyQty
      && state.latest.sellQty === action.row.sellQty
    ) {
      return state;
    }
  }
  const row = liveRow(action.row, state.sequence);
  const firstLiveTime = state.firstLiveTime ?? row.time;
  let nextLines = state.lines;
  if (row.netQtyChange !== 0) {
    const entry: ProgramLine = { kind: "row", row };
    nextLines = state.lines.length >= MAX_LIVE_PROGRAM_LINES
      ? [...state.lines.slice(-(MAX_LIVE_PROGRAM_LINES - 1)), entry]
      : [...state.lines, entry];
  }
  const appendedTrend = [...state.trend, row.netQty];
  const trend = appendedTrend.length > MAX_PROGRAM_TREND_POINTS
    ? downsampleMinMax(appendedTrend, Math.floor(MAX_PROGRAM_TREND_POINTS / 2))
    : appendedTrend;
  return { firstLiveTime, lastTickSeconds: action.row.t, latest: row, lines: nextLines, trend, sequence: state.sequence + 1 };
}

export function sparklinePoints(netQtys: readonly number[], width: number, height: number): string {
  if (netQtys.length < 2) return "";
  const sampled = downsampleMinMax(netQtys, Math.max(4, Math.round(width) * 2));
  let low = sampled[0]!;
  let high = low;
  for (let i = 1; i < sampled.length; i++) {
    const value = sampled[i]!;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const span = high - low || 1;
  return sampled.map((value, index) => `${((index / (sampled.length - 1)) * width).toFixed(2)},${(height - ((value - low) / span) * height).toFixed(2)}`).join(" ");
}

export const isNoProgramData = (history: readonly ProgramRow[], live: readonly ProgramLine[]): boolean => history.length === 0 && rowsOf(live).length === 0;
