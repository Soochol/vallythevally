import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useOrdersStatus } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import type { Capacity } from "./orderRules";
import { groupOpenOrders, type PriceGroup } from "./orderRules";
import { fetchCommands, fetchOpenOrders, fetchOrderable } from "./orderApi";
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
}

export function useOrderData(code: string, open: boolean, referencePrice: number | null): OrderBoardData {
  const openOrders = useQuery({ queryKey: [...ORDER_QUERY_KEY, "open"], queryFn: ({ signal }) => fetchOpenOrders(signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const commands = useQuery({ queryKey: [...ORDER_QUERY_KEY, "commands"], queryFn: ({ signal }) => fetchCommands(signal), enabled: open, refetchInterval: POLL_MS, staleTime: 0, retry: false });
  const orderableEnabled = open && referencePrice !== null;
  const sellable = useQuery({ queryKey: [...ORDER_QUERY_KEY, "orderable", code, "sell"], queryFn: ({ signal }) => fetchOrderable(code, "sell", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const buyable = useQuery({ queryKey: [...ORDER_QUERY_KEY, "orderable", code, "buy"], queryFn: ({ signal }) => fetchOrderable(code, "buy", referencePrice!, signal), enabled: orderableEnabled, refetchInterval: POLL_MS * 3, staleTime: POLL_MS, retry: false });
  const orders = openOrders.data?.orders;
  const groups = useMemo(() => groupOpenOrders(orders ?? [], code), [orders, code]);
  return {
    groups,
    blocked: commands.data?.blocked ?? false,
    capacity: { sellableQuantity: sellable.data?.quantity ?? null, buyableAmount: buyable.data?.amount ?? null },
  };
}
