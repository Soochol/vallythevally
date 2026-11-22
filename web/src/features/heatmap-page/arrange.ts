import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { layoutTiles, type TileRect } from "./treemap";
import type { SizeMode, SortMode } from "./settings";

export interface SnapshotRow {
  code: SymbolCode;
  name: string;
  changeRate: number | null;
  tradedMillionWon: number | null;
}

export function boardRows(theme: HeatmapBoardTheme, names: ReadonlyMap<SymbolCode, string>): SnapshotRow[] {
  const quoted = theme.members.map((member) => ({ code: member.symbol, name: member.name, changeRate: member.changeRate, tradedMillionWon: member.tradedMillionWon ?? null }));
  const unquoted = theme.missing.map((code) => ({ code, name: names.get(code) ?? code, changeRate: null, tradedMillionWon: null }));
  return [...quoted, ...unquoted];
}

const byName = (a: SnapshotRow, b: SnapshotRow) => a.name.localeCompare(b.name, "ko") || a.code.localeCompare(b.code);
const descending = (pick: (row: SnapshotRow) => number | null) => (a: SnapshotRow, b: SnapshotRow) => {
  const left = pick(a);
  const right = pick(b);
  if (left === right) return byName(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
};

export function sortRows(rows: readonly SnapshotRow[], sort: SortMode): SnapshotRow[] {
  const compare = sort === "name" ? byName : descending(sort === "rate" ? (row) => row.changeRate : (row) => row.tradedMillionWon);
  return [...rows].sort(compare);
}

export function hasTradedValue(rows: readonly SnapshotRow[]): boolean {
  return rows.some((row) => row.tradedMillionWon !== null && row.tradedMillionWon > 0);
}

export function tileWeights(rows: readonly SnapshotRow[], size: SizeMode): number[] {
  if (size === "equal" || !hasTradedValue(rows)) return rows.map(() => 1);
  const known = rows.flatMap((row) => (row.tradedMillionWon !== null && row.tradedMillionWon > 0 ? [row.tradedMillionWon] : []));
  const floor = Math.min(...known);
  return rows.map((row) => (row.tradedMillionWon !== null && row.tradedMillionWon > 0 ? row.tradedMillionWon : floor));
}

export interface Arrangement {
  rows: SnapshotRow[];
  rects: Map<SymbolCode, TileRect>;
}

export function arrange(rows: readonly SnapshotRow[], size: SizeMode, sort: SortMode, width: number, height: number): Arrangement {
  const sorted = sortRows(rows, sort);
  const weights = tileWeights(sorted, size);
  const ranked = sorted.map((row, i) => ({ key: row.code, weight: weights[i]! }));
  const rects = new Map(layoutTiles(ranked, width, height).map((rect) => [rect.key as SymbolCode, rect]));
  return { rows: sorted, rects };
}
