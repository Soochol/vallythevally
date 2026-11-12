import { queryOptions, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FinancialPeriod } from "./generated/FinancialPeriod";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { getJson, sendJson } from "./http";

interface FinancialRequest {
  symbol: string;
  period: FinancialPeriod;
}

const keyOf = ({ symbol, period }: FinancialRequest) => ["financials", symbol, period];
const urlOf = ({ symbol, period }: FinancialRequest) => `/api/symbols/${encodeURIComponent(symbol)}/financials?period=${period}`;

export const financialsQuery = (request: FinancialRequest) => queryOptions({
  queryKey: keyOf(request),
  queryFn: ({ signal }) => getJson<FinancialsPage>(urlOf(request), signal),
  staleTime: 0,
  retry: false,
});

export async function refreshFinancials(client: QueryClient, request: FinancialRequest): Promise<void> {
  await client.cancelQueries({ queryKey: keyOf(request) });
  try {
    await sendJson<FinancialsPage>("POST", urlOf(request), "{}");
  } finally {
    await client.cancelQueries({ queryKey: keyOf(request) });
    await client.invalidateQueries({ queryKey: keyOf(request) });
  }
}

export function useFinancials(symbol: string, period: FinancialPeriod, enabled: boolean) {
  const client = useQueryClient();
  const request = { symbol, period };
  const query = useQuery({
    ...financialsQuery(request),
    enabled,
    refetchInterval: (q) => enabled && (q.state.data?.status === "collecting" || q.state.data?.status === "stale") ? 1000 : false,
  });
  const refresh = useMutation({
    mutationFn: (request: FinancialRequest) => refreshFinancials(client, request),
  });
  const current = refresh.variables?.symbol === symbol && refresh.variables.period === period;
  return { ...query, refresh: () => refresh.mutate(request), refreshError: current ? refresh.error : null, refreshing: current && refresh.isPending };
}
