import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import { marketSocket, quoteBook } from "../../stores/realtime";
import { fetchBalance } from "./orderApi";
import { ORDER_QUERY_KEY } from "./useOrderWrites";

export const BALANCE_POLL_MS = 15_000;
const BALANCE_STALE_MS = 5_000;
const NO_ACCOUNT = "none";

const balanceQueryKey = (scope: string) => [...ORDER_QUERY_KEY, scope, "balance"] as const;

export function useAccountBalance(account: string | null, enabled: boolean): TradingBalance | null {
  const client = useQueryClient();
  const scope = account ?? NO_ACCOUNT;
  const balance = useQuery({
    queryKey: balanceQueryKey(scope),
    queryFn: ({ signal }) => fetchBalance(account, signal),
    enabled,
    refetchInterval: BALANCE_POLL_MS,
    refetchOnMount: "always",
    staleTime: BALANCE_STALE_MS,
    retry: false,
  });

  useEffect(() => {
    if (!enabled) return;
    let wasClosed = false;
    const stopWatch = marketSocket.watch((connection) => {
      if (connection.socket === "closed") {
        wasClosed = true;
      } else if (connection.socket === "open" && wasClosed) {
        wasClosed = false;
        void client.invalidateQueries({ queryKey: balanceQueryKey(scope) });
      }
    });
    const stopAccount = marketSocket.watchTradingAccount((changed) => {
      if (changed === account) void client.invalidateQueries({ queryKey: balanceQueryKey(scope) });
    });
    return () => {
      stopWatch();
      stopAccount();
    };
  }, [client, enabled, account, scope]);

  const codesKey = enabled ? (balance.data?.holdings ?? []).map((holding) => holding.code).join("\0") : "";
  useEffect(() => {
    if (codesKey === "") return;
    return quoteBook.lease(codesKey.split("\0"), { front: true });
  }, [codesKey]);

  return balance.data ?? null;
}
