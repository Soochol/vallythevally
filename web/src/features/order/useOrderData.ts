import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useOrdersStatus } from "../../api/system";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { marketSocket } from "../../stores/realtime";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import type { Capacity } from "./orderRules";
import { groupOpenOrders, type PriceGroup } from "./orderRules";
import { fetchBalance, fetchCommands, fetchExecutions, fetchOpenOrders, fetchOrderable } from "./orderApi";
import { ORDER_QUERY_KEY } from "./useOrderWrites";

const POLL_MS = 5000;

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
  readonly openOrders: readonly TradingOpenOrder[];
  readonly balance: TradingBalance | null;
  readonly executions: readonly TradingExecution[];
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
  const sellable = useQuery({ queryKey: [...ORDER_QUERY_KEY, "orderable", code, "sell"], queryFn: ({ signal }) => fetchOrderable(code, "sell", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const buyable = useQuery({ queryKey: [...ORDER_QUERY_KEY, "orderable", code, "buy"], queryFn: ({ signal }) => fetchOrderable(code, "buy", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const orders = openOrders.data?.orders;
  const groups = useMemo(() => groupOpenOrders(orders ?? [], code), [orders, code]);
  return {
    groups,
    blocked: commands.data?.blocked ?? false,
    openOrders: orders ?? NONE,
    balance: balance.data ?? null,
    executions: executions.data?.executions ?? NONE,
    capacity: { sellableQuantity: sellable.data?.quantity ?? null, buyableAmount: buyable.data?.amount ?? null },
  };
}
