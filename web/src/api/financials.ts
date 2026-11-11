import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FinancialPeriod } from "./generated/FinancialPeriod";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { getJson, sendJson } from "./http";

interface FinancialRequest {
  symbol: string;
  period: FinancialPeriod;
}

const keyOf = ({ symbol, period }: FinancialRequest) => ["financials", symbol, period];
const urlOf = ({ symbol, period }: FinancialRequest) => `/api/symbols/${encodeURIComponent(symbol)}/financials?period=${period}`;

export function useFinancials(symbol: string, period: FinancialPeriod, enabled: boolean) {
  const client = useQueryClient();
  const request = { symbol, period };
  const query = useQuery({
    queryKey: keyOf(request),
    queryFn: ({ signal }) => getJson<FinancialsPage>(urlOf(request), signal),
    enabled,
    staleTime: 0,
    refetchInterval: (q) => enabled && (q.state.data?.status === "collecting" || q.state.data?.status === "stale") ? 1000 : false,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: (request: FinancialRequest) => sendJson<FinancialsPage>("POST", urlOf(request), "{}"),
    onMutate: (request) => client.cancelQueries({ queryKey: keyOf(request) }),
    onSuccess: (data, request) => client.setQueryData(keyOf(request), data),
  });
  const current = refresh.variables?.symbol === symbol && refresh.variables.period === period;
  return { ...query, refresh: () => refresh.mutate(request), refreshError: current ? refresh.error : null, refreshing: current && refresh.isPending };
}
