import type { HeatmapFlowSeries } from "../../src/api/generated/HeatmapFlowSeries";
import type { HeatmapThemes } from "../../src/api/generated/HeatmapThemes";
import type { Quote } from "../../src/api/generated/Quote";
import { boardOf, parseOrder } from "../../dev/fakeHeatmapBoard";
import type { Scenario } from "./scenario";

export interface HeatmapRow {
  rate: number;
  traded: number;
}

export type HeatmapTable = Record<string, HeatmapRow>;

export const HEATMAP_TABLE: HeatmapTable = {
  "005930": { rate: 2, traded: 300_000 },
  "000660": { rate: -1, traded: 200_000 },
  "028260": { rate: 5, traded: 50_000 },
  "086520": { rate: -4, traded: 10_000 },
};

export const HEATMAP_NAMES: Record<string, string> = { "005930": "삼성전자", "000660": "SK하이닉스", "028260": "삼성물산", "086520": "에코프로" };

export const BASE_PRICE = 100_000;
export const QUOTED_AT = 1_794_186_000;

export function heatmapQuote(symbol: string, row: HeatmapRow, source: Quote["source"] = "polled"): Quote {
  const change = (BASE_PRICE * row.rate) / 100;
  return { symbol, price: BASE_PRICE + change, change, changeRate: row.rate, volume: 1_000_000, t: QUOTED_AT, source, venue: "combined", ...(source === "polled" ? { tradedMillionWon: row.traded } : {}) };
}

export const HEATMAP_THEMES: HeatmapThemes = {
  revision: 100,
  themes: [
    { id: "chips", name: "반도체", symbols: ["005930", "000660"] },
    { id: "holding", name: "지주", symbols: ["028260", "086520"] },
  ],
};

export function seedHeatmapThemes(scenario: Scenario, table: HeatmapTable, themes: HeatmapThemes = HEATMAP_THEMES): string[] {
  const asked: string[] = [];
  scenario.documents.saveHeatmapThemes(themes);
  scenario.on("/api/quotes", (request) => {
    const symbols = (new URL(request.url()).searchParams.get("symbols") ?? "").split(",");
    return { body: symbols.flatMap((symbol) => (table[symbol] ? [heatmapQuote(symbol, table[symbol])] : [])) };
  });
  scenario.on("/api/heatmap/board", (request) => {
    const order = parseOrder(new URL(request.url()).searchParams.get("order")) ?? "rate";
    asked.push(order);
    const memberOf = (code: string) => {
      const row = table[code];
      return row ? { symbol: code, name: HEATMAP_NAMES[code] ?? code, changeRate: row.rate, tradedMillionWon: row.traded } : null;
    };
    return { body: boardOf(scenario.documents.heatmapThemes(), memberOf, order, QUOTED_AT) };
  });
  return asked;
}

const NINE_KST = Date.UTC(2026, 10, 9, 0, 0, 0) / 1000;
const FIVE_MINUTES = 300;

export function flowSeries(rates: readonly number[], used: readonly string[], rest: Partial<HeatmapFlowSeries> = {}): HeatmapFlowSeries {
  return {
    date: "2026-11-09",
    bucketMinutes: 5,
    points: rates.map((rate, i) => ({ t: NINE_KST + i * FIVE_MINUTES, rate })),
    used: [...used],
    missing: [],
    overLimit: [],
    limit: 60,
    ...rest,
  };
}

export const HEATMAP_FLOWS: Record<string, HeatmapFlowSeries> = {
  "005930,000660": flowSeries([0.5, 1.2, 1.8, 2.1], ["005930", "000660"]),
  "028260,086520": flowSeries([-0.4, 0.3, -0.2], ["028260", "086520"]),
};

export function seedHeatmapFlow(scenario: Scenario, flows: Record<string, HeatmapFlowSeries>): string[] {
  const asked: string[] = [];
  scenario.on("/api/heatmap/flow", (request) => {
    const symbols = new URL(request.url()).searchParams.get("symbols") ?? "";
    asked.push(symbols);
    const flow = flows[symbols];
    return flow ? { body: flow } : { status: 404, body: { error: { code: "unknown_symbol", message: "없는 종목입니다", reason: null, retryAt: null, manualActionRequired: false } } };
  });
  return asked;
}
