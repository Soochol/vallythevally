import { queryOptions, useQuery } from "@tanstack/react-query";
import type { EtfFundDetail } from "./generated/EtfFundDetail";
import type { EtfFundList } from "./generated/EtfFundList";
import { getJson } from "./http";

const STALE_MS = 60_000;

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
