import { queryOptions, useQuery } from "@tanstack/react-query";
import type { FinancialPeriod } from "./generated/FinancialPeriod";
import type { FinancialsPage } from "./generated/FinancialsPage";
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
  return useQuery({ ...financialsQuery({ symbol, period }), enabled });
}
