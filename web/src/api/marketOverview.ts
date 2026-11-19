import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import type { Market } from "./generated/Market";
import type { MarketOverviewFlowCard } from "./generated/MarketOverviewFlowCard";
import type { MarketOverviewIndexCard } from "./generated/MarketOverviewIndexCard";
import type { MarketOverviewIntradayFlow } from "./generated/MarketOverviewIntradayFlow";
import type { MarketOverviewPeriod } from "./generated/MarketOverviewPeriod";
import type { MarketOverviewSectorsCard } from "./generated/MarketOverviewSectorsCard";
import type { MarketOverviewStreaksCard } from "./generated/MarketOverviewStreaksCard";
import type { MarketOverviewTurnoverCard } from "./generated/MarketOverviewTurnoverCard";
import type { Ranking } from "./generated/Ranking";
import { getJson } from "./http";
import { fetchRanking } from "./rankings";

export const MARKET_REFRESH_MS = 60_000;

const refreshing = { staleTime: MARKET_REFRESH_MS, refetchInterval: MARKET_REFRESH_MS, retry: false, placeholderData: keepPreviousData } as const;

const path = (route: string, market: Market, period?: MarketOverviewPeriod) =>
  `/api/market-overview/${route}?market=${market}${period === undefined ? "" : `&period=${period}`}`;

export const marketIndexQuery = (market: Market) =>
  queryOptions({ queryKey: ["market-overview", "index", market], queryFn: ({ signal }) => getJson<MarketOverviewIndexCard>(path("index", market), signal), ...refreshing });

export const marketSectorsQuery = (market: Market) =>
  queryOptions({ queryKey: ["market-overview", "sectors", market], queryFn: ({ signal }) => getJson<MarketOverviewSectorsCard>(path("sectors", market), signal), ...refreshing });

export const marketFlowQuery = (market: Market, period: MarketOverviewPeriod) =>
  queryOptions({ queryKey: ["market-overview", "flow", market, period], queryFn: ({ signal }) => getJson<MarketOverviewFlowCard>(path("flow", market, period), signal), ...refreshing });

export const marketIntradayQuery = (market: Market) =>
  queryOptions({ queryKey: ["market-overview", "flow-intraday", market], queryFn: ({ signal }) => getJson<MarketOverviewIntradayFlow>(path("flow/intraday", market), signal), ...refreshing });

export const marketTurnoverQuery = (market: Market, period: MarketOverviewPeriod) =>
  queryOptions({ queryKey: ["market-overview", "turnover", market, period], queryFn: ({ signal }) => getJson<MarketOverviewTurnoverCard>(path("turnover", market, period), signal), ...refreshing });

export const marketStreaksQuery = (market: Market) =>
  queryOptions({ queryKey: ["market-overview", "streaks", market], queryFn: ({ signal }) => getJson<MarketOverviewStreaksCard>(path("streaks", market), signal), ...refreshing });

export const marketRankingQuery = (ranking: Ranking) =>
  queryOptions({ queryKey: ["market-overview", "ranking", ranking], queryFn: () => fetchRanking(ranking, 1, "user"), ...refreshing });

type Gate = { enabled: boolean };

export const useMarketIndex = (market: Market, { enabled }: Gate) => useQuery({ ...marketIndexQuery(market), enabled });
export const useMarketSectors = (market: Market, { enabled }: Gate) => useQuery({ ...marketSectorsQuery(market), enabled });
export const useMarketFlow = (market: Market, period: MarketOverviewPeriod, { enabled }: Gate) => useQuery({ ...marketFlowQuery(market, period), enabled });
export const useMarketIntraday = (market: Market, { enabled }: Gate) => useQuery({ ...marketIntradayQuery(market), enabled });
export const useMarketTurnover = (market: Market, period: MarketOverviewPeriod, { enabled }: Gate) => useQuery({ ...marketTurnoverQuery(market, period), enabled });
export const useMarketStreaks = (market: Market, { enabled }: Gate) => useQuery({ ...marketStreaksQuery(market), enabled });
export const useMarketRanking = (ranking: Ranking, { enabled }: Gate) => useQuery({ ...marketRankingQuery(ranking), enabled });
