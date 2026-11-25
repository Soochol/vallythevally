import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { marketSocket } from "../../stores/realtime";
import { useKiwoomOnlyLink } from "../../stores/kiwoomLink";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import type { OrderAccountChoice } from "./orderAccount";
import { buyingPowerOf, type Capacity, groupWithPending, type PriceGroup } from "./orderRules";
import { observeOrderExecutions } from "./orderSound";
import { pendingWrites } from "./pendingWrites";
import { fetchCommands, fetchExecutions, fetchOpenOrders, fetchOrderable } from "./orderApi";
import { holdingOf } from "./holdingSummary";
import { isBalanceQueryKey } from "./useAccountBalance";
import { ORDER_QUERY_KEY } from "./useOrderWrites";

const POLL_MS = 5000;
const NO_ACCOUNT = "none";

export const ORDERABLE_QUERY_KEY = [...ORDER_QUERY_KEY, "orderable"] as const;

export interface OrderAccess {
  readonly open: boolean;
  readonly reason: string | null;
}

export function useOrderAccess(choice: OrderAccountChoice): OrderAccess {
  const link = useKiwoomOnlyLink();
  if (choice.current?.broker !== "kis" && link !== null && link.state !== "connected") return { open: false, reason: "키움에 연결되지 않아 주문할 수 없습니다" };
  if (!choice.current) return { open: false, reason: "주문 사용 상태를 확인하는 중입니다" };
  if (choice.current.state !== "on") return { open: false, reason: choice.current.message || "주문 사용이 꺼져 있습니다" };
  return { open: true, reason: null };
}

export interface OrderBoardData {
  readonly groups: ReadonlyMap<string, PriceGroup>;
  readonly blocked: boolean;
  readonly capacity: Capacity;
  readonly orderable: TradingOrderable | null;
  readonly buyableProblem: string | null;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly openOrdersListedAt: number;
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
}

function sellableQuantityOf(balance: TradingBalance | null, code: string): number | null {
  if (balance === null) return null;
  return holdingOf(balance.holdings, code)?.sellableQuantity ?? 0;
}

const NONE: readonly never[] = [];

function useRefreshOnAccountChange(client: QueryClient, enabled: boolean, account: string | null): void {
  useEffect(() => {
    if (!enabled) return;
    return marketSocket.watchTradingAccount((changed) => {
      if (changed === account) {
        void client.invalidateQueries({ queryKey: ORDER_QUERY_KEY, predicate: (query) => !isBalanceQueryKey(query.queryKey) });
      }
    });
  }, [client, enabled, account]);
}

export function useOrderData(account: string | null, code: string, open: boolean, referencePrice: number | null, balance: TradingBalance | null): OrderBoardData {
  const client = useQueryClient();
  const scope = account ?? NO_ACCOUNT;
  const openOrders = useQuery({ queryKey: [...ORDER_QUERY_KEY, scope, "open"], queryFn: ({ signal }) => fetchOpenOrders(account, signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const commands = useQuery({ queryKey: [...ORDER_QUERY_KEY, scope, "commands"], queryFn: ({ signal }) => fetchCommands(account, signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const executions = useQuery({
    queryKey: [...ORDER_QUERY_KEY, scope, "executions"],
    queryFn: async ({ signal }) => {
      const data = await fetchExecutions(account, signal);
      observeOrderExecutions(client, data);
      return data;
    },
    enabled: open,
    refetchInterval: POLL_MS * 3,
    staleTime: POLL_MS,
    retry: false,
  });
  useRefreshOnAccountChange(client, open, account);
  const orderableEnabled = open && referencePrice !== null;
  const buyable = useQuery({ queryKey: [...ORDERABLE_QUERY_KEY, scope, code, "buy"], queryFn: ({ signal }) => fetchOrderable(account, code, "buy", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const orders = openOrders.data?.orders;
  const writes = useSyncExternalStore(pendingWrites.subscribe, pendingWrites.snapshot);
  const fetchedAt = openOrders.dataUpdatedAt;
  useEffect(() => { if (orders) pendingWrites.observe(code, { orders, at: fetchedAt }); }, [orders, fetchedAt, code]);
  const groups = useMemo(() => groupWithPending(orders ?? NONE, writes, code), [orders, writes, code]);
  const capacity = useMemo(() => ({ sellableQuantity: sellableQuantityOf(balance, code), buying: buyingPowerOf(buyable.data ?? null) }), [balance, buyable.data, code]);
  return {
    groups,
    blocked: commands.data?.blocked ?? false,
    openOrders: orders ?? NONE,
    openOrdersListedAt: fetchedAt,
    balance,
    executions: executions.data?.executions ?? NONE,
    orderable: buyable.data ?? null,
    capacity,
    buyableProblem: buyable.error?.message ?? null,
  };
}
