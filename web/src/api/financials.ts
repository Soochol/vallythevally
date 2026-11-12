import { useEffect } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FinancialPeriod } from "./generated/FinancialPeriod";
import type { FinancialsPage } from "./generated/FinancialsPage";
import { updateActive, useFinancialUpdate } from "./financialUpdate";
import { getJson } from "./http";

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

export function useFinancials(symbol: string, period: FinancialPeriod, enabled: boolean) {
  const client = useQueryClient();
  const update = useFinancialUpdate(enabled).data;
  const active = updateActive(update?.status);
  useEffect(() => {
    if (enabled) void client.invalidateQueries({ queryKey: ["financials"] });
  }, [client, enabled, update?.id, update?.status, update?.completedCompanies, update?.failedCompanies, update?.phase, update?.historyCompletedCompanies, update?.historyFailedCompanies]);
  const request = { symbol, period };
  const query = useQuery({
    ...financialsQuery(request),
    enabled,
    refetchInterval: () => enabled && active ? 1000 : false,
  });
  return query;
}
