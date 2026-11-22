import type { HeatmapBoard } from "../../src/api/generated/HeatmapBoard";
import type { HeatmapBoardMember } from "../../src/api/generated/HeatmapBoardMember";
import type { HeatmapBoardTheme } from "../../src/api/generated/HeatmapBoardTheme";
import type { HeatmapThemeOrder } from "../../src/api/generated/HeatmapThemeOrder";
import type { HeatmapThemes } from "../../src/api/generated/HeatmapThemes";
import type { HeatmapThemeSummary } from "../../src/api/generated/HeatmapThemeSummary";

export type MemberOf = (code: string) => HeatmapBoardMember | null;

function summaryOf(members: readonly HeatmapBoardMember[]): HeatmapThemeSummary | null {
  const leader = members.reduce<HeatmapBoardMember | null>((best, m) => (best === null || m.changeRate > best.changeRate ? m : best), null);
  if (leader === null) return null;
  const traded = members.flatMap((m) => (m.tradedMillionWon === undefined ? [] : [[m.changeRate, m.tradedMillionWon] as const]));
  const total = traded.reduce((sum, [, t]) => sum + t, 0);
  const weightedRate = total > 0 ? Math.round((traded.reduce((sum, [rate, t]) => sum + rate * t, 0) / total) * 10_000) / 10_000 : null;
  return {
    weightedRate,
    tradedMillionWon: total,
    rising: members.filter((m) => m.changeRate > 0).length,
    flat: members.filter((m) => m.changeRate === 0).length,
    falling: members.filter((m) => m.changeRate < 0).length,
    leader: leader.symbol,
  };
}

function keyOf(theme: HeatmapBoardTheme, order: HeatmapThemeOrder): number | null {
  if (!theme.summary || order === "custom") return null;
  return order === "rate" ? theme.summary.weightedRate : theme.summary.tradedMillionWon;
}

export function boardOf(document: HeatmapThemes, memberOf: MemberOf, order: HeatmapThemeOrder, asOf: number | null): HeatmapBoard {
  const themes = document.themes.map((theme): HeatmapBoardTheme => {
    const found = theme.symbols.map((code) => [code, memberOf(code)] as const);
    const members = found.flatMap(([, member]) => (member ? [member] : []));
    return { id: theme.id, name: theme.name, summary: summaryOf(members), members, missing: found.flatMap(([code, member]) => (member ? [] : [code])) };
  });
  const ordered = order === "custom" ? themes : themes.map((theme, i) => ({ theme, i })).sort((a, b) => {
    const [left, right] = [keyOf(a.theme, order), keyOf(b.theme, order)];
    if (left === right) return a.i - b.i;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || a.i - b.i;
  }).map(({ theme }) => theme);
  return { revision: document.revision, order, asOf, themes: ordered };
}

export const parseOrder = (raw: string | null): HeatmapThemeOrder | null => (raw === null ? "rate" : raw === "rate" || raw === "custom" || raw === "traded" ? raw : null);
