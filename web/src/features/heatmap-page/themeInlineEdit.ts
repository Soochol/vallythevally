import type { HeatmapBoard } from "../../api/generated/HeatmapBoard";
import type { HeatmapBoardMember } from "../../api/generated/HeatmapBoardMember";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { HeatmapThemeOrder } from "../../api/generated/HeatmapThemeOrder";
import type { HeatmapThemeSummary } from "../../api/generated/HeatmapThemeSummary";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { boardRows, sortRows } from "./arrange";
import type { SortMode } from "./settings";

export type RateIntensityLevel = 0 | 1 | 2 | 3;

export function rateIntensityLevel(rate: number | null): RateIntensityLevel {
  if (rate === null) return 0;
  const magnitude = Math.abs(rate);
  if (magnitude < 0.3) return 0;
  if (magnitude < 1.5) return 1;
  if (magnitude < 3.0) return 2;
  return 3;
}

function summarizeMembers(members: readonly HeatmapBoardMember[]): HeatmapThemeSummary | null {
  const leader = members.reduce<HeatmapBoardMember | null>(
    (best, member) => (best === null || member.changeRate > best.changeRate ? member : best),
    null,
  );
  if (leader === null) return null;
  let weightedSum = 0;
  let totalTraded = 0;
  for (const member of members) {
    if (member.tradedMillionWon === undefined) continue;
    weightedSum += member.changeRate * member.tradedMillionWon;
    totalTraded += member.tradedMillionWon;
  }
  const weightedRate = totalTraded > 0 ? Math.round((weightedSum / totalTraded) * 10_000) / 10_000 : null;
  return {
    weightedRate,
    tradedMillionWon: totalTraded,
    rising: members.filter((member) => member.changeRate > 0).length,
    flat: members.filter((member) => member.changeRate === 0).length,
    falling: members.filter((member) => member.changeRate < 0).length,
    leader: leader.symbol,
  };
}

function orderKey(theme: HeatmapBoardTheme, order: HeatmapThemeOrder): number | null {
  if (!theme.summary || order === "custom") return null;
  return order === "rate" ? theme.summary.weightedRate : theme.summary.tradedMillionWon;
}

export function themesFromBoard(board: HeatmapBoard): HeatmapTheme[] {
  return board.themes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    symbols: [...theme.members.map((member) => member.symbol), ...theme.missing],
  }));
}

export function snapshotVisualThemes(
  boardThemes: readonly HeatmapBoardTheme[],
  sort: SortMode,
  names: ReadonlyMap<SymbolCode, string>,
): HeatmapTheme[] {
  return boardThemes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    symbols: sortRows(boardRows(theme, names), sort).map((row) => row.code),
  }));
}

export function projectBoardThemes(
  board: HeatmapBoard,
  themes: readonly HeatmapTheme[],
  order: HeatmapThemeOrder,
  liveRateOf?: (code: SymbolCode) => number | null,
  extraNames?: ReadonlyMap<SymbolCode, string>,
): HeatmapBoard {
  const knownMembers = new Map<SymbolCode, HeatmapBoardMember>();
  for (const theme of board.themes) {
    for (const member of theme.members) {
      if (!knownMembers.has(member.symbol)) knownMembers.set(member.symbol, member);
    }
  }
  const projected = themes.map((theme): HeatmapBoardTheme => {
    const members: HeatmapBoardMember[] = [];
    const missing: SymbolCode[] = [];
    for (const code of theme.symbols) {
      const existing = knownMembers.get(code);
      if (existing) {
        members.push(existing);
        continue;
      }
      const liveRate = liveRateOf?.(code) ?? null;
      if (liveRate !== null) {
        members.push({ symbol: code, name: extraNames?.get(code) ?? code, changeRate: liveRate });
      } else {
        missing.push(code);
      }
    }
    return { id: theme.id, name: theme.name, summary: summarizeMembers(members), members, missing };
  });
  const ordered = order === "custom"
    ? projected
    : projected
      .map((theme, index) => ({ theme, index }))
      .sort((a, b) => {
        const left = orderKey(a.theme, order);
        const right = orderKey(b.theme, order);
        if (left === right) return a.index - b.index;
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left || a.index - b.index;
      })
      .map(({ theme }) => theme);
  return { ...board, order, themes: ordered };
}

export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
