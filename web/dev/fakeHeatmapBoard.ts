import type { HeatmapBoard } from "../src/api/generated/HeatmapBoard.ts";
import type { HeatmapBoardMember } from "../src/api/generated/HeatmapBoardMember.ts";
import type { HeatmapBoardTheme } from "../src/api/generated/HeatmapBoardTheme.ts";
import type { HeatmapSource } from "../src/api/generated/HeatmapSource.ts";
import type { HeatmapTheme } from "../src/api/generated/HeatmapTheme.ts";
import type { HeatmapThemeOrder } from "../src/api/generated/HeatmapThemeOrder.ts";
import type { HeatmapThemes } from "../src/api/generated/HeatmapThemes.ts";
import type { HeatmapThemeSummary } from "../src/api/generated/HeatmapThemeSummary.ts";
import type { KiwoomCatalogInfo } from "../src/api/generated/KiwoomCatalogInfo.ts";

export interface KiwoomCatalog {
  info: KiwoomCatalogInfo;
  themes: readonly HeatmapTheme[];
}

export const FAKE_KIWOOM_CATALOG: KiwoomCatalog = {
  info: { date: "2026-11-23", collectedAt: 1_795_000_000, themes: 9, state: "ready" },
  themes: [
    { id: "kiwoom-101", name: "반도체", symbols: ["005930", "000660", "009150"] },
    { id: "kiwoom-102", name: "2차전지", symbols: ["373220", "006400", "051910", "247540", "086520"] },
    { id: "kiwoom-103", name: "자동차", symbols: ["005380", "000270", "012330"] },
    { id: "kiwoom-104", name: "바이오", symbols: ["207940", "068270", "196170"] },
    { id: "kiwoom-105", name: "금융지주", symbols: ["055550", "105560", "032830"] },
    { id: "kiwoom-106", name: "인터넷", symbols: ["035420", "035720"] },
    { id: "kiwoom-107", name: "삼성그룹", symbols: ["005930", "028260", "207940", "032830", "009150", "006400"] },
    { id: "kiwoom-108", name: "원자력", symbols: ["034020"] },
    { id: "kiwoom-109", name: "지주사", symbols: ["003550"] },
  ],
};

export const EMPTY_KIWOOM_CATALOG: KiwoomCatalog = { info: { date: null, collectedAt: null, themes: 0, state: "empty" }, themes: [] };

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

function orderedThemes(source: readonly HeatmapTheme[], memberOf: MemberOf, order: HeatmapThemeOrder): HeatmapBoardTheme[] {
  const themes = source.map((theme): HeatmapBoardTheme => {
    const found = theme.symbols.map((code) => [code, memberOf(code)] as const);
    const members = found.flatMap(([, member]) => (member ? [member] : []));
    return { id: theme.id, name: theme.name, summary: summaryOf(members), members, missing: found.flatMap(([code, member]) => (member ? [] : [code])) };
  });
  return order === "custom" ? themes : themes.map((theme, i) => ({ theme, i })).sort((a, b) => {
    const [left, right] = [keyOf(a.theme, order), keyOf(b.theme, order)];
    if (left === right) return a.i - b.i;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || a.i - b.i;
  }).map(({ theme }) => theme);
}

export function boardOf(document: HeatmapThemes, memberOf: MemberOf, order: HeatmapThemeOrder, asOf: number | null): HeatmapBoard {
  return { revision: document.revision, order, asOf, source: "mine", catalog: null, themes: orderedThemes(document.themes, memberOf, order) };
}

export function kiwoomBoardOf(catalog: KiwoomCatalog, memberOf: MemberOf, order: HeatmapThemeOrder, asOf: number | null): HeatmapBoard {
  const themes = catalog.info.state === "ready" ? orderedThemes(catalog.themes, memberOf, order) : [];
  return { revision: 0, order, asOf, source: "kiwoom", catalog: catalog.info, themes };
}

export const parseSource = (raw: string | null): HeatmapSource | null => (raw === null ? "mine" : raw === "mine" || raw === "kiwoom" ? raw : null);

export const parseOrder = (raw: string | null): HeatmapThemeOrder | null => (raw === null ? "rate" : raw === "rate" || raw === "custom" || raw === "traded" ? raw : null);
