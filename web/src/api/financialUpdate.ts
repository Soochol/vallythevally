import { queryOptions, type QueryClient, useQuery } from "@tanstack/react-query";
import type { FinancialUpdateStatus } from "./generated/FinancialUpdateStatus";
import type { FinancialUpdatePage } from "./generated/FinancialUpdatePage";
import { getJson, sendJson } from "./http";

export const updateActive = (status: FinancialUpdateStatus | undefined) => status === "planning" || status === "collecting" || status === "pausing";
export const financialUpdateQuery = queryOptions({
  queryKey: ["financial-update"],
  queryFn: ({ signal }) => getJson<FinancialUpdatePage>("/api/financial-update", signal),
  staleTime: 0,
  retry: false,
  refetchInterval: (query) => updateActive(query.state.data?.status) ? 1000 : false,
});

export function useFinancialUpdate(enabled = true) {
  return useQuery({ ...financialUpdateQuery, enabled });
}

export async function commandFinancialUpdate(client: QueryClient, action: "start" | "pause" | "resume"): Promise<void> {
  const keys = [["financial-update"], ["financials"]];
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
  try {
    await sendJson<FinancialUpdatePage>("POST", action === "start" ? "/api/financial-update" : `/api/financial-update/${action}`, "{}");
  } finally {
    await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
    await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  }
}
