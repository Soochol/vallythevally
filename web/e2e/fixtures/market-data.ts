import type { Market } from "../../src/api/generated/Market";
import type { MarketOverviewFlowCard } from "../../src/api/generated/MarketOverviewFlowCard";
import type { MarketOverviewIndexCard } from "../../src/api/generated/MarketOverviewIndexCard";
import type { MarketOverviewIntradayFlow } from "../../src/api/generated/MarketOverviewIntradayFlow";
import type { MarketOverviewSectorsCard } from "../../src/api/generated/MarketOverviewSectorsCard";
import type { MarketOverviewStreak } from "../../src/api/generated/MarketOverviewStreak";
import type { MarketOverviewStreaksCard } from "../../src/api/generated/MarketOverviewStreaksCard";
import type { MarketOverviewTurnoverCard } from "../../src/api/generated/MarketOverviewTurnoverCard";
import type { RankingPage } from "../../src/api/generated/RankingPage";
import type { RankingRequest } from "../../src/api/generated/RankingRequest";
import type { RankingRow } from "../../src/api/generated/RankingRow";
import type { FixtureReply, Scenario } from "./scenario";

type Wire<T> = T extends bigint ? number : T extends readonly (infer U)[] ? Wire<U>[] : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;

const RECEIVED_AT = 1_794_186_000;

const context = (market: Market) => ({ market, phase: "regular", receivedAt: RECEIVED_AT, source: "kiwoom" }) as const;
const part = <T>(value: T) => ({ status: "ok", value }) as const;

const NAMES: Record<Market, string> = { kospi: "코스피", kosdaq: "코스닥" };

export const MARKET_INDEX_LEVEL: Record<Market, number> = { kospi: 2650.12, kosdaq: 850.5 };

const index = (market: Market): Wire<MarketOverviewIndexCard> => ({
  context: context(market),
  index: part(
    market === "kospi"
      ? { code: "001", name: NAMES.kospi, level: MARKET_INDEX_LEVEL.kospi, changeRate: 0.85, breadth: { rising: 520, flat: 60, falling: 310, upperLimit: 3, lowerLimit: 1 }, tradeValueEok: 85_000, volatility: { level: 18.4, changeRate: -1.2 } }
      : { code: "101", name: NAMES.kosdaq, level: MARKET_INDEX_LEVEL.kosdaq, changeRate: -0.3, breadth: { rising: 800, flat: 80, falling: 900, upperLimit: 5, lowerLimit: 2 }, tradeValueEok: 60_000, volatility: null },
  ),
});

export const SECTOR_NAMES: Record<Market, readonly [string, string, string]> = { kospi: ["전기전자", "금융업", "의약품"], kosdaq: ["반도체", "제약", "IT부품"] };

const sectors = (market: Market): Wire<MarketOverviewSectorsCard> => {
  const [a, b, c] = SECTOR_NAMES[market];
  const flowOf = (code: string, name: string, wholeMarket: boolean, individualEok: number, foreignEok: number, institutionEok: number) => ({ code, name, wholeMarket, individualEok, foreignEok, institutionEok });
  return {
    context: context(market),
    sectors: part([
      { code: "013", name: a, level: 900.1, changeRate: 2.1, tradeValueEok: 30_000 },
      { code: "021", name: b, level: 700.2, changeRate: -0.8, tradeValueEok: 12_000 },
      { code: "009", name: c, level: 500.3, changeRate: 0.4, tradeValueEok: 6_000 },
    ]),
    flows: part([
      flowOf("001", `${NAMES[market]} 종합`, true, -1_200, 800, 400),
      flowOf("013", a, false, -700, 1_500, -800),
      flowOf("021", b, false, 300, -200, -100),
      flowOf("009", c, false, 50, 20, -70),
    ]),
  };
};

const flow = (market: Market): Wire<MarketOverviewFlowCard> => ({
  context: context(market),
  period: "20",
  investors: part([
    { date: "2026-11-05", individualEok: 500, foreignEok: -300, institutionEok: -200 },
    { date: "2026-11-06", individualEok: -100, foreignEok: 600, institutionEok: -500 },
    { date: "2026-11-09", individualEok: -400, foreignEok: 100, institutionEok: 300 },
  ]),
  program: part([
    { date: "2026-11-06", arbitrageEok: 10, nonArbitrageEok: 90, totalEok: 100 },
    { date: "2026-11-09", arbitrageEok: -20, nonArbitrageEok: 50, totalEok: 30 },
  ]),
});

const intraday = (market: Market): Wire<MarketOverviewIntradayFlow> => ({
  context: context(market),
  day: "2026-11-09",
  points: [
    { at: 1_794_150_000, individualEok: 0, foreignEok: 0, institutionEok: 0, programEok: 0 },
    { at: 1_794_150_060, individualEok: 120, foreignEok: -60, institutionEok: -30, programEok: 15 },
    { at: 1_794_150_120, individualEok: 260, foreignEok: -150, institutionEok: -40, programEok: null },
    { at: 1_794_150_180, individualEok: 310, foreignEok: -210, institutionEok: 20, programEok: 40 },
  ],
});

const turnover = (market: Market): Wire<MarketOverviewTurnoverCard> => ({
  context: context(market),
  period: "20",
  days: part([
    { date: "2026-11-05", tradeValueEok: 70_000 },
    { date: "2026-11-06", tradeValueEok: 82_000 },
    { date: "2026-11-09", tradeValueEok: 91_000 },
  ]),
});

const streak = (code: string, name: string, days: number): Wire<MarketOverviewStreak> => ({ code, name, days, netEok: days * 40, netShares: days * 1000, periodChangeRate: days * 0.5 });

const streaks = (market: Market): Wire<MarketOverviewStreaksCard> => {
  const [buyF, buyI, sellF, sellI] = market === "kospi" ? ["삼성물산", "SK하이닉스", "LG화학", "기아"] : ["에코프로", "알테오젠", "리노공업", "HPSP"];
  return {
    context: context(market),
    buying: part({ foreign: [streak("028260", buyF!, 5)], institution: [streak("000660", buyI!, 3)] }),
    selling: part({ foreign: [streak("051910", sellF!, -4)], institution: [streak("000270", sellI!, -2)] }),
  };
};

const BUILDERS: Record<string, (market: Market) => unknown> = { index, sectors, flow, "flow/intraday": intraday, turnover, streaks };

export function marketOverviewBaseline(url: URL, method: string): FixtureReply | null {
  const route = /^\/api\/market-overview\/(.+)$/.exec(url.pathname)?.[1];
  if (route === undefined || method !== "GET") return null;
  const build = BUILDERS[route];
  const market = url.searchParams.get("market");
  if (build === undefined || (market !== "kospi" && market !== "kosdaq")) return null;
  return { body: build(market) };
}

export const marketOverviewCalls = (scenario: Scenario, route: string, market: Market): number =>
  scenario.requests.filter((request) => {
    const url = new URL(request.url());
    return url.pathname === `/api/market-overview/${route}` && url.searchParams.get("market") === market;
  }).length;

export const anyMarketOverviewCall = (scenario: Scenario): boolean => scenario.requests.some((request) => new URL(request.url()).pathname.startsWith("/api/market-overview/"));

const row = (rank: number, code: string, name: string, changeRate: number, figures: RankingRow["figures"]): RankingRow => ({ rank, code, name, listed: true, price: 70_000 + rank, changeRate, figures });

export const RANKING_ROWS: Record<Market, Record<"tradeAmount" | "gainers" | "losers", RankingRow[]>> = {
  kospi: {
    tradeAmount: [row(1, "005930", "삼성전자", 1.5, { kind: "tradeAmount", tradeAmount: 900_000_000_000, volume: 1_000_000, placesGained: 0 }), row(2, "028260", "삼성물산", -0.5, { kind: "tradeAmount", tradeAmount: 500_000_000_000, volume: 800_000, placesGained: 1 })],
    gainers: [row(1, "000660", "SK하이닉스", 8.2, { kind: "movers", priceChange: 9_000, volume: 700_000 })],
    losers: [row(1, "051910", "LG화학", -6.1, { kind: "movers", priceChange: -20_000, volume: 300_000 })],
  },
  kosdaq: {
    tradeAmount: [row(1, "086520", "에코프로", 3.3, { kind: "tradeAmount", tradeAmount: 300_000_000_000, volume: 500_000, placesGained: 0 })],
    gainers: [row(1, "196170", "알테오젠", 12.0, { kind: "movers", priceChange: 30_000, volume: 200_000 })],
    losers: [row(1, "058470", "리노공업", -4.4, { kind: "movers", priceChange: -9_000, volume: 100_000 })],
  },
};

export function serveMarketRankings(scenario: Scenario): void {
  scenario.on(
    (url, request) => url.pathname === "/api/rankings" && request.method() === "POST",
    (request) => {
      const asked: RankingRequest = request.postDataJSON();
      const ranking = asked.ranking;
      const market: Market = "market" in ranking && ranking.market === "kosdaq" ? "kosdaq" : "kospi";
      const rows = ranking.kind === "tradeAmount" || ranking.kind === "gainers" || ranking.kind === "losers" ? RANKING_ROWS[market][ranking.kind] : [];
      return { body: { rows, pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(scenario.now / 1000), source: "kiwoom" } satisfies RankingPage };
    },
  );
}
