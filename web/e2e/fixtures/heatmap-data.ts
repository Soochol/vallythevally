import type { Quote } from "../../src/api/generated/Quote";
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

export function heatmapQuote(symbol: string, row: HeatmapRow, source: Quote["source"] = "polled"): Quote {
  const change = (BASE_PRICE * row.rate) / 100;
  return { symbol, price: BASE_PRICE + change, change, changeRate: row.rate, volume: 1_000_000, t: 1_794_186_000, source, venue: "combined", ...(source === "polled" ? { tradedMillionWon: row.traded } : {}) };
}

export function seedHeatmapGroups(scenario: Scenario, table: HeatmapTable): void {
  scenario.documents.saveWatchlists({
    revision: 100,
    lists: [{ id: "L", name: "기본", symbols: ["005930", "000660", "028260", "086520"], groups: [
      { id: "chips", name: "반도체", symbols: ["005930", "000660"] },
      { id: "holding", name: "지주", symbols: ["028260", "086520"] },
    ] }],
  });
  scenario.on("/api/quotes", (request) => {
    const asked = (new URL(request.url()).searchParams.get("symbols") ?? "").split(",");
    return { body: asked.flatMap((symbol) => (table[symbol] ? [heatmapQuote(symbol, table[symbol])] : [])) };
  });
}
