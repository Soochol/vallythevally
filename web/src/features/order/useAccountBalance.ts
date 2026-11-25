import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import { EXECUTION_FORENSICS_QUERY_KEY } from "../../api/trading";
import { marketSocket, quoteBook } from "../../stores/realtime";
import { fetchBalance } from "./orderApi";
import { ORDER_QUERY_KEY } from "./useOrderWrites";

export const BALANCE_POLL_MS = 15_000;
const NO_ACCOUNT = "none";

const balanceQueryKey = (account: string | null) => [...ORDER_QUERY_KEY, account ?? NO_ACCOUNT, "balance"] as const;

class BalanceHub {
  private readonly accounts = new Map<string | null, number>();
  private stop: (() => void) | null = null;
  private wasClosed = false;

  constructor(private readonly client: QueryClient) {}

  acquire(account: string | null): () => void {
    this.accounts.set(account, (this.accounts.get(account) ?? 0) + 1);
    if (this.stop === null) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.accounts.get(account) ?? 0) - 1;
      if (next > 0) this.accounts.set(account, next);
      else this.accounts.delete(account);
      if (this.accounts.size === 0) this.teardown();
    };
  }

  private start(): void {
    this.wasClosed = false;
    const stopWatch = marketSocket.watch((connection) => {
      if (connection.socket === "closed") {
        this.wasClosed = true;
      } else if (connection.socket === "open" && this.wasClosed) {
        this.wasClosed = false;
        for (const account of this.accounts.keys()) {
          void this.client.invalidateQueries({ queryKey: balanceQueryKey(account) });
        }
      }
    });
    const stopAccount = marketSocket.watchTradingAccount((changed) => {
      if (this.accounts.has(changed)) {
        void this.client.invalidateQueries({ queryKey: ORDER_QUERY_KEY });
        void this.client.invalidateQueries({ queryKey: EXECUTION_FORENSICS_QUERY_KEY });
      }
    });
    this.stop = () => {
      stopWatch();
      stopAccount();
    };
  }

  private teardown(): void {
    this.stop?.();
    this.stop = null;
    this.wasClosed = false;
  }
}

const hubs = new WeakMap<QueryClient, BalanceHub>();

function hubOf(client: QueryClient): BalanceHub {
  let hub = hubs.get(client);
  if (hub === undefined) {
    hub = new BalanceHub(client);
    hubs.set(client, hub);
  }
  return hub;
}

export function useAccountBalance(account: string | null, enabled: boolean): TradingBalance | null {
  const client = useQueryClient();
  const balance = useQuery({
    queryKey: balanceQueryKey(account),
    queryFn: ({ signal }) => fetchBalance(account, signal),
    enabled,
    refetchInterval: BALANCE_POLL_MS,
    refetchOnMount: "always",
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!enabled) return;
    return hubOf(client).acquire(account);
  }, [client, enabled, account]);

  const codesKey = enabled ? (balance.data?.holdings ?? []).map((holding) => holding.code).join("\0") : "";
  useEffect(() => {
    if (codesKey === "") return;
    return quoteBook.lease(codesKey.split("\0"), { front: true });
  }, [codesKey]);

  return balance.data ?? null;
}
