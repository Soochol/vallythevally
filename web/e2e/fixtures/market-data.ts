import type { Market } from "../../src/api/generated/Market";
import type { MarketOverviewDerivedCard } from "../../src/api/generated/MarketOverviewDerivedCard";
import type { MarketOverviewFlowCard } from "../../src/api/generated/MarketOverviewFlowCard";
import type { MarketOverviewIndexCard } from "../../src/api/generated/MarketOverviewIndexCard";
import type { MarketOverviewIntradayFlow } from "../../src/api/generated/MarketOverviewIntradayFlow";
import type { MarketOverviewScope } from "../../src/api/generated/MarketOverviewScope";
import type { MarketOverviewSectorsCard } from "../../src/api/generated/MarketOverviewSectorsCard";
import type { MarketOverviewStreak } from "../../src/api/generated/MarketOverviewStreak";
import type { MarketOverviewStreaksCard } from "../../src/api/generated/MarketOverviewStreaksCard";
import type { MarketOverviewThemesCard } from "../../src/api/generated/MarketOverviewThemesCard";
import type { MarketOverviewTurnoverCard } from "../../src/api/generated/MarketOverviewTurnoverCard";
import type { MarketOverviewViCard } from "../../src/api/generated/MarketOverviewViCard";
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

export const indexCardWithoutBreadth = (market: Market): Wire<MarketOverviewIndexCard> => {
  const card = index(market);
  if (card.index.status !== "ok") return card;
  return { ...card, index: part({ ...card.index.value, breadth: { rising: null, flat: null, falling: null, upperLimit: null, lowerLimit: null } }) };
};

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

const derived = (scope: MarketOverviewScope): Wire<MarketOverviewDerivedCard> => {
  const scale = scope === "all" ? 1 : scope === "kospi" ? 0.45 : 0.55;
  const counts = [18, 64, 210, 420, 480, 560, 310, 112, 26].map((value) => Math.max(1, Math.round(value * scale)));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const labels = ["≤-10%", "-10~-5%", "-5~-2%", "-2~-0.5%", "-0.5~+0.5%", "+0.5~+2%", "+2~+5%", "+5~+10%", "≥+10%"];
  const attributionMarket: Market = scope === "kosdaq" ? "kosdaq" : "kospi";
  const topPositive =
    attributionMarket === "kosdaq"
      ? [
          { code: "196170", name: "알테오젠", market: "kosdaq" as const, changeRate: 6.4, points: 4.82, capDeltaEok: 8_200 },
          { code: "086520", name: "에코프로", market: "kosdaq" as const, changeRate: 3.3, points: 2.15, capDeltaEok: 3_600 },
        ]
      : [
          { code: "005930", name: "삼성전자", market: "kospi" as const, changeRate: 2.4, points: 11.42, capDeltaEok: 82_000 },
          { code: "000660", name: "SK하이닉스", market: "kospi" as const, changeRate: 4.1, points: 7.85, capDeltaEok: 56_000 },
        ];
  const topNegative =
    attributionMarket === "kosdaq"
      ? [{ code: "058470", name: "리노공업", market: "kosdaq" as const, changeRate: -4.4, points: -1.94, capDeltaEok: -2_900 }]
      : [{ code: "051910", name: "LG화학", market: "kospi" as const, changeRate: -3.2, points: -3.12, capDeltaEok: -14_000 }];

  const krxEok = scope === "kosdaq" ? 48_000 : scope === "kospi" ? 71_000 : 119_000;
  const nxtEok = scope === "kosdaq" ? 12_000 : scope === "kospi" ? 14_000 : 26_000;
  const krxPct = Math.round((krxEok / (krxEok + nxtEok)) * 1000) / 10;
  const nxtPct = Math.round((100 - krxPct) * 10) / 10;

  return {
    scope,
    phase: "regular",
    receivedAt: RECEIVED_AT,
    histogram: part(
      labels.map((label, idx) => ({
        label,
        count: counts[idx]!,
        sharePct: Math.round((counts[idx]! / total) * 1000) / 10,
      })),
    ),
    venueShare: part({
      krxTradeValueEok: krxEok,
      nxtTradeValueEok: nxtEok,
      krxRatioPct: krxPct,
      nxtRatioPct: nxtPct,
    }),
    attribution: part({
      market: attributionMarket,
      indexChangePoints: attributionMarket === "kosdaq" ? -2.56 : 22.34,
      topPositive,
      topNegative,
      topTwoConcentrationPct: attributionMarket === "kosdaq" ? 58.2 : 64.5,
    }),
    maThrust: part({
      asOf: "2026-11-09",
      totalStocks: total,
      above5Pct: scope === "kosdaq" ? 46.2 : 62.4,
      above20Pct: scope === "kosdaq" ? 41.8 : 58.6,
      above60Pct: scope === "kosdaq" ? 39.5 : 54.1,
      above200Pct: scope === "kosdaq" ? 34.0 : 49.8,
      history20d: [
        { date: "2026-11-03", above20Pct: 48.2 },
        { date: "2026-11-04", above20Pct: 51.0 },
        { date: "2026-11-05", above20Pct: 53.4 },
        { date: "2026-11-06", above20Pct: 56.1 },
        { date: "2026-11-09", above20Pct: scope === "kosdaq" ? 41.8 : 58.6 },
      ],
    }),
  };
};

const themes = (): Wire<MarketOverviewThemesCard> => ({
  phase: "regular",
  receivedAt: RECEIVED_AT,
  source: "kiwoom",
  themes: part([
    { code: "301", name: "HBM·AI반도체", stockCount: 24, changeRate: 3.45, periodReturn: 8.2, rising: 21, falling: 2, leaders: ["SK하이닉스", "삼성전자"] },
    { code: "302", name: "2차전지 소재", stockCount: 18, changeRate: 1.85, periodReturn: 4.1, rising: 14, falling: 3, leaders: ["에코프로", "LG화학"] },
    { code: "303", name: "바이오 신약", stockCount: 15, changeRate: -0.92, periodReturn: -1.4, rising: 4, falling: 10, leaders: ["알테오젠"] },
  ]),
});

const vi = (scope: MarketOverviewScope): Wire<MarketOverviewViCard> => {
  const allEvents = [
    { code: "000660", name: "SK하이닉스", market: "kospi" as const, direction: "up" as const, triggeredAt: "101532", releasedAt: "101732", triggerPrice: 198_500, staticVi: true, dynamicVi: false, dispersionRate: 10.25 },
    { code: "086520", name: "에코프로", market: "kosdaq" as const, direction: "up" as const, triggeredAt: "102108", releasedAt: null, triggerPrice: 94_200, staticVi: false, dynamicVi: true, dispersionRate: 6.4 },
    { code: "051910", name: "LG화학", market: "kospi" as const, direction: "down" as const, triggeredAt: "100415", releasedAt: "100615", triggerPrice: 312_000, staticVi: true, dynamicVi: true, dispersionRate: -8.1 },
  ];
  const filtered = scope === "all" ? allEvents : allEvents.filter((event) => event.market === scope);
  return {
    scope,
    phase: "regular",
    receivedAt: RECEIVED_AT,
    source: "kiwoom",
    events: part(filtered),
  };
};

const BUILDERS: Record<string, (market: Market) => unknown> = { index, sectors, flow, "flow/intraday": intraday, turnover, streaks };

const parseScope = (raw: string | null): MarketOverviewScope | null => {
  if (raw === null || raw === "all") return "all";
  if (raw === "kospi" || raw === "kosdaq") return raw;
  return null;
};

export function marketOverviewBaseline(url: URL, method: string): FixtureReply | null {
  const route = /^\/api\/market-overview\/(.+)$/.exec(url.pathname)?.[1];
  if (route === undefined || method !== "GET") return null;
  if (route === "themes") return { body: themes() };
  if (route === "derived") {
    const scope = parseScope(url.searchParams.get("scope"));
    return scope === null ? null : { body: derived(scope) };
  }
  if (route === "vi") {
    const scope = parseScope(url.searchParams.get("scope"));
    return scope === null ? null : { body: vi(scope) };
  }
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

export const marketOverviewScopedCalls = (scenario: Scenario, route: string, scope: MarketOverviewScope): number =>
  scenario.requests.filter((request) => {
    const url = new URL(request.url());
    return url.pathname === `/api/market-overview/${route}` && (url.searchParams.get("scope") ?? "all") === scope;
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
      const requestedMarket = "market" in ranking ? ranking.market : "kospi";
      const rows =
        ranking.kind === "tradeAmount" || ranking.kind === "gainers" || ranking.kind === "losers"
          ? requestedMarket === "all"
            ? [...RANKING_ROWS.kospi[ranking.kind], ...RANKING_ROWS.kosdaq[ranking.kind]].map((item, idx) => ({ ...item, rank: idx + 1 }))
            : RANKING_ROWS[requestedMarket === "kosdaq" ? "kosdaq" : "kospi"][ranking.kind]
          : [];
      return { body: { rows, pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(scenario.now / 1000), source: "kiwoom" } satisfies RankingPage };
    },
  );
}
