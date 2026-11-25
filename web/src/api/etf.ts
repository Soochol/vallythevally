import { queryOptions, useQuery } from "@tanstack/react-query";
import type { EtfAccumulation } from "./generated/EtfAccumulation";
import type { EtfAccumulationDirection } from "./generated/EtfAccumulationDirection";
import type { EtfAccumulationStyle } from "./generated/EtfAccumulationStyle";
import type { EtfChanges } from "./generated/EtfChanges";
import type { EtfFundDetail } from "./generated/EtfFundDetail";
import type { EtfFundList } from "./generated/EtfFundList";
import type { EtfHistory } from "./generated/EtfHistory";
import type { EtfSimilarFunds } from "./generated/EtfSimilarFunds";
import type { EtfStockHolders } from "./generated/EtfStockHolders";
import { getJson } from "./http";

const STALE_MS = 60_000;

export type EtfAccumulationWindow = 5 | 20;

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
