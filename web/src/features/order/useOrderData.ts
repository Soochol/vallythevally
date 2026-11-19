import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useOrdersStatus } from "../../api/system";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { marketSocket } from "../../stores/realtime";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { buyingPowerOf, type Capacity, groupWithPending, type PriceGroup } from "./orderRules";
import { pendingWrites } from "./pendingWrites";
import { fetchBalance, fetchCommands, fetchExecutions, fetchOpenOrders, fetchOrderable } from "./orderApi";
import { holdingOf } from "./holdingSummary";
import { ORDER_QUERY_KEY } from "./useOrderWrites";

const POLL_MS = 5000;

export const ORDERABLE_QUERY_KEY = [...ORDER_QUERY_KEY, "orderable"] as const;

export interface OrderAccess {
  readonly open: boolean;
  readonly reason: string | null;
}

export function useOrderAccess(): OrderAccess {
  const orders = useOrdersStatus().data;
  const link = useKiwoomLinkStore((s) => s.status);
  if (link !== null && link.state !== "connected") return { open: false, reason: "키움에 연결되지 않아 주문할 수 없습니다" };
  if (!orders) return { open: false, reason: "주문 사용 상태를 확인하는 중입니다" };
  if (orders.state !== "on") return { open: false, reason: orders.message || "주문 사용이 꺼져 있습니다" };
  return { open: true, reason: null };
}

export interface OrderBoardData {
  readonly groups: ReadonlyMap<string, PriceGroup>;
  readonly blocked: boolean;
  readonly capacity: Capacity;
  readonly orderable: TradingOrderable | null;
  readonly buyableProblem: string | null;
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
}

function sellableQuantityOf(balance: TradingBalance | null, code: string): number | null {
  if (balance === null) return null;
  return holdingOf(balance.holdings, code)?.sellableQuantity ?? 0;
}

const NONE: readonly never[] = [];

function useRefreshOnAccountChange(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return marketSocket.watchTradingAccount(() => void client.invalidateQueries({ queryKey: ORDER_QUERY_KEY }));
  }, [client, enabled]);
}

export function useOrderData(code: string, open: boolean, referencePrice: number | null): OrderBoardData {
  const openOrders = useQuery({ queryKey: [...ORDER_QUERY_KEY, "open"], queryFn: ({ signal }) => fetchOpenOrders(signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const commands = useQuery({ queryKey: [...ORDER_QUERY_KEY, "commands"], queryFn: ({ signal }) => fetchCommands(signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const balance = useQuery({ queryKey: [...ORDER_QUERY_KEY, "balance"], queryFn: ({ signal }) => fetchBalance(signal), enabled: open, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const executions = useQuery({ queryKey: [...ORDER_QUERY_KEY, "executions"], queryFn: ({ signal }) => fetchExecutions(signal), enabled: open, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  useRefreshOnAccountChange(open);
  const orderableEnabled = open && referencePrice !== null;
  const buyable = useQuery({ queryKey: [...ORDERABLE_QUERY_KEY, code, "buy"], queryFn: ({ signal }) => fetchOrderable(code, "buy", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const orders = openOrders.data?.orders;
  const writes = useSyncExternalStore(pendingWrites.subscribe, pendingWrites.snapshot);
  const fetchedAt = openOrders.dataUpdatedAt;
  useEffect(() => { if (orders) pendingWrites.observe(code, { orders, at: fetchedAt }); }, [orders, fetchedAt, code]);
  const groups = useMemo(() => groupWithPending(orders ?? NONE, writes, code), [orders, writes, code]);
  return {
    groups,
    blocked: commands.data?.blocked ?? false,
    openOrders: orders ?? NONE,
    balance: balance.data ?? null,
    executions: executions.data?.executions ?? NONE,
    orderable: buyable.data ?? null,
    capacity: { sellableQuantity: sellableQuantityOf(balance.data ?? null, code), buying: buyingPowerOf(buyable.data ?? null) },
    buyableProblem: buyable.error?.message ?? null,
  };
}
