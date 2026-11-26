import { queryOptions, useQuery } from "@tanstack/react-query";
import type { EtfAccumulation } from "./generated/EtfAccumulation";
import type { EtfAccumulationDirection } from "./generated/EtfAccumulationDirection";
import type { EtfAccumulationStyle } from "./generated/EtfAccumulationStyle";
import type { EtfChanges } from "./generated/EtfChanges";
import type { EtfFlowDirection } from "./generated/EtfFlowDirection";
import type { EtfFlowRanking } from "./generated/EtfFlowRanking";
import type { EtfFlowScope } from "./generated/EtfFlowScope";
import type { EtfFlowSort } from "./generated/EtfFlowSort";
import type { EtfFundDetail } from "./generated/EtfFundDetail";
import type { EtfFundList } from "./generated/EtfFundList";
import type { EtfHistory } from "./generated/EtfHistory";
import type { EtfSharesSeries } from "./generated/EtfSharesSeries";
import type { EtfSimilarFunds } from "./generated/EtfSimilarFunds";
import type { EtfStockHolders } from "./generated/EtfStockHolders";
import { getJson } from "./http";

const STALE_MS = 60_000;

export type EtfAccumulationWindow = 5 | 20;
export type EtfFlowWindow = 1 | 5 | 20 | 60;
export type EtfSharesDays = 20 | 60 | 120 | 250;

export const etfFundsQuery = queryOptions({
  queryKey: ["etf", "funds"],
  queryFn: ({ signal }) => getJson<EtfFundList>("/api/etf/funds", signal),
  staleTime: STALE_MS,
});

export const etfFundQuery = (code: string) =>
  queryOptions({
    queryKey: ["etf", "fund", code],
    queryFn: ({ signal }) => getJson<EtfFundDetail>(`/api/etf/funds/${encodeURIComponent(code)}`, signal),
    staleTime: STALE_MS,
  });

export const useEtfFunds = () => useQuery(etfFundsQuery);

export const useEtfFund = (code: string | null) => useQuery({ ...etfFundQuery(code ?? ""), enabled: code !== null });

export const etfStockQuery = (code: string) =>
  queryOptions({
    queryKey: ["etf", "stock", code],
    queryFn: ({ signal }) => getJson<EtfStockHolders>(`/api/etf/stocks/${encodeURIComponent(code)}`, signal),
    staleTime: STALE_MS,
  });

export const useEtfStock = (code: string | null) => useQuery({ ...etfStockQuery(code ?? ""), enabled: code !== null });

export const etfHistoryQuery = (code: string) =>
  queryOptions({
    queryKey: ["etf", "history", code],
    queryFn: ({ signal }) => getJson<EtfHistory>(`/api/etf/funds/${encodeURIComponent(code)}/history`, signal),
    staleTime: STALE_MS,
  });

export const useEtfHistory = (code: string) => useQuery(etfHistoryQuery(code));

export const etfChangesQuery = (code: string, before: string, after: string) =>
  queryOptions({
    queryKey: ["etf", "changes", code, before, after],
    queryFn: ({ signal }) => getJson<EtfChanges>(`/api/etf/funds/${encodeURIComponent(code)}/changes?before=${before}&after=${after}`, signal),
    staleTime: STALE_MS,
  });

export const useEtfChanges = (code: string, pair: { before: string; after: string } | null) => useQuery({ ...etfChangesQuery(code, pair?.before ?? "", pair?.after ?? ""), enabled: pair !== null });

export const etfAccumulationQuery = (
  window: EtfAccumulationWindow,
  style: EtfAccumulationStyle,
  direction: EtfAccumulationDirection = "buy",
) =>
  queryOptions({
    queryKey: ["etf", "accumulation", window, style, direction],
    queryFn: ({ signal }) =>
      getJson<EtfAccumulation>(`/api/etf/accumulation?window=${window}&style=${style}&direction=${direction}`, signal),
    staleTime: STALE_MS,
  });

export const useEtfAccumulation = (
  window: EtfAccumulationWindow,
  style: EtfAccumulationStyle,
  direction: EtfAccumulationDirection = "buy",
) => useQuery(etfAccumulationQuery(window, style, direction));

export const etfSimilarQuery = (code: string) =>
  queryOptions({
    queryKey: ["etf", "similar", code],
    queryFn: ({ signal }) => getJson<EtfSimilarFunds>(`/api/etf/funds/${encodeURIComponent(code)}/similar`, signal),
    staleTime: STALE_MS,
  });

export const useEtfSimilar = (code: string) => useQuery(etfSimilarQuery(code));

export const etfFlowsQuery = (
  window: EtfFlowWindow,
  direction: EtfFlowDirection,
  scope: EtfFlowScope,
  sort: EtfFlowSort,
  limit = 100,
) =>
  queryOptions({
    queryKey: ["etf", "flows", window, direction, scope, sort, limit],
    queryFn: ({ signal }) =>
      getJson<EtfFlowRanking>(
        `/api/etf/flows?window=${window}&direction=${direction}&scope=${scope}&sort=${sort}&limit=${limit}`,
        signal,
      ),
    staleTime: STALE_MS,
  });

export const useEtfFlows = (
  window: EtfFlowWindow,
  direction: EtfFlowDirection,
  scope: EtfFlowScope,
  sort: EtfFlowSort,
  limit = 100,
) => useQuery(etfFlowsQuery(window, direction, scope, sort, limit));

export const etfSharesQuery = (code: string, days: EtfSharesDays = 60) =>
  queryOptions({
    queryKey: ["etf", "shares", code, days],
    queryFn: ({ signal }) =>
      getJson<EtfSharesSeries>(`/api/etf/funds/${encodeURIComponent(code)}/shares?days=${days}`, signal),
    staleTime: STALE_MS,
  });

export const useEtfShares = (code: string | null, days: EtfSharesDays = 60) =>
  useQuery({ ...etfSharesQuery(code ?? "", days), enabled: code !== null });
