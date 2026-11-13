import { queryOptions, type QueryClient, useQuery } from "@tanstack/react-query";
import type { FinancialUpdatePage } from "./generated/FinancialUpdatePage";
import { financialJobActive, type FinancialJobCommand } from "../lib/financialJob";
import { getJson, sendJson } from "./http";

export const financialUpdateQuery = queryOptions({
  queryKey: ["financial-update"],
  queryFn: ({ signal }) => getJson<FinancialUpdatePage>("/api/financial-update", signal),
  staleTime: 0,
  retry: false,
  refetchInterval: (query) => financialJobActive(query.state.data?.status) ? 1000 : false,
});

export function useFinancialUpdate(enabled = true) {
  return useQuery({ ...financialUpdateQuery, enabled });
}

export async function commandFinancialUpdate(client: QueryClient, action: FinancialJobCommand): Promise<void> {
  const keys = [["financial-update"], ["financials"]];
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
  try {
    await sendJson<FinancialUpdatePage>("POST", action === "start" ? "/api/financial-update" : `/api/financial-update/${action}`, "{}");
  } finally {
    await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
    await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  }
}
