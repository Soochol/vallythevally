import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useKiwoomLinkStore } from "../stores/kiwoomLink";

const NAME_QUERY_ROOTS = ["symbol", "symbols"] as const;

const unnamed = (query: Query) => query.state.status !== "success";

export async function refetchFailedNames(client: QueryClient): Promise<void> {
  await Promise.all(NAME_QUERY_ROOTS.map((root) => client.cancelQueries({ queryKey: [root], predicate: unnamed })));
  await Promise.all(NAME_QUERY_ROOTS.map((root) => client.refetchQueries({ queryKey: [root], type: "all", predicate: unnamed })));
}

export function useRefetchNamesOnConnect(): void {
  const client = useQueryClient();
  const connected = useKiwoomLinkStore((s) => s.status?.state === "connected");
  useEffect(() => {
    if (connected) void refetchFailedNames(client);
  }, [connected, client]);
}
