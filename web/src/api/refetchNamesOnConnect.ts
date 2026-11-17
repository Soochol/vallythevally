import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useKiwoomLinkStore } from "../stores/kiwoomLink";

const NAME_QUERY_ROOTS = ["symbol", "symbols"] as const;

export function refetchFailedNames(client: QueryClient): Promise<void> {
  return Promise.all(
    NAME_QUERY_ROOTS.map((root) => client.refetchQueries({ queryKey: [root], type: "all", predicate: (query) => query.state.status === "error" })),
  ).then(() => undefined);
}

export function useRefetchNamesOnConnect(): void {
  const client = useQueryClient();
  const connected = useKiwoomLinkStore((s) => s.status?.state === "connected");
  useEffect(() => {
    if (connected) void refetchFailedNames(client);
  }, [connected, client]);
}
