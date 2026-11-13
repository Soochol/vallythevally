import { hashKey, queryOptions, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function watchFinancialJob(client: QueryClient): () => void {
  const jobHash = hashKey(financialUpdateQuery.queryKey);
  let seen: unknown;
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.query.queryHash !== jobHash) return;
    const page: unknown = event.query.state.data;
    if (page === seen) return;
    seen = page;
    void client.invalidateQueries({ queryKey: ["financials"] });
  });
}

export function useFinancialJob(enabled = true) {
  const client = useQueryClient();
  const query = useQuery({ ...financialUpdateQuery, enabled });
  const mutation = useMutation({ mutationFn: (action: FinancialJobCommand) => commandFinancialUpdate(client, action) });
  const page = query.data;
  return { page, query, active: financialJobActive(page?.status), command: { run: mutation.mutate, pending: mutation.isPending, error: mutation.error } };
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
