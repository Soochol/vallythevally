import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderCommands } from "../../api/generated/OrderCommands";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import { cancelAction, cancelBatchAction, createLedger, modifyAction, newIdFor, placeAction, type Settlement } from "./commandLedger";
import { cancelOrder, cancelOrdersAtPrice, modifyOrder, placeOrder, reconcileOrders } from "./orderApi";
import { needsHighValueConfirm } from "./orderRules";
import { IDLE_STATUS, isUnanswered, type OrderStatus, statusOfCommand, statusOfFailure } from "./statusText";

export const ORDER_QUERY_KEY = ["order"] as const;

const ledger = createLedger(newIdFor);

export function statusOfBatch(result: OrderCommands): OrderStatus {
  if (result.commands.length === 0) return { tone: "info", text: "취소할 주문이 없습니다" };
  const worst = result.commands.find((c) => c.state === "unknown") ?? result.commands.find((c) => c.state === "rejected") ?? result.commands[0]!;
  const done = result.commands.filter((c) => c.state === "accepted").length;
  if (worst.state === "accepted") return { tone: "ok", text: `취소 접수 · ${done}건` };
  const status = statusOfCommand(worst);
  return done > 0 ? { ...status, text: `${status.text} (접수 ${done}건)` } : status;
}

export interface PlaceRequest {
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly confirmHighValue: boolean;
}

export interface OrderWrites {
  readonly status: OrderStatus;
  readonly queued: number;
  place(request: PlaceRequest): void;
  modifyAll(orders: readonly TradingOpenOrder[], price: number): void;
  cancelOne(orderNo: string): void;
  cancelAtPrice(side: OrderSide, price: number): void;
  reconcile(): void;
  say(status: OrderStatus): void;
}

export function useOrderWrites(code: string, venue: Venue): OrderWrites {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<OrderStatus>(IDLE_STATUS);
  const [queued, setQueued] = useState(0);
  const tail = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback(<T,>(action: string, call: (id: string) => Promise<T>, describe: (result: T) => OrderStatus) => {
    const issued = ledger.issue(action);
    if (!issued.send) return;
    setQueued((n) => n + 1);
    tail.current = tail.current.then(async () => {
      let settlement: Settlement = "answered";
      try {
        setStatus(describe(await call(issued.id)));
      } catch (error) {
        if (isUnanswered(error)) settlement = "unanswered";
        setStatus(statusOfFailure(error));
      } finally {
        ledger.settle(action, settlement);
        setQueued((n) => n - 1);
        void queryClient.invalidateQueries({ queryKey: ORDER_QUERY_KEY });
      }
    });
  }, [queryClient]);

  const place = useCallback((r: PlaceRequest) => enqueue(
    placeAction(code, r.side, r.price, r.quantity, venue),
    (commandId) => placeOrder({ commandId, code, side: r.side, quantity: r.quantity, price: r.price, venue, confirmHighValue: r.confirmHighValue }),
    statusOfCommand,
  ), [code, venue, enqueue]);

  const modifyAll = useCallback((orders: readonly TradingOpenOrder[], price: number) => {
    for (const order of orders) enqueue(
      modifyAction(order.orderNo, price),
      (commandId) => modifyOrder({ commandId, orderNo: order.orderNo, price, confirmHighValue: needsHighValueConfirm(price, order.openQuantity) }),
      (command: OrderCommand) => statusOfCommand(command),
    );
  }, [enqueue]);

  const cancelOne = useCallback((orderNo: string) => enqueue(cancelAction(orderNo), (commandId) => cancelOrder({ commandId, orderNo }), statusOfCommand), [enqueue]);

  const cancelAtPrice = useCallback((side: OrderSide, price: number) => enqueue(
    cancelBatchAction(code, side, price),
    (batchId) => cancelOrdersAtPrice({ batchId, code, side, price }),
    statusOfBatch,
  ), [code, enqueue]);

  const reconcile = useCallback(() => {
    reconcileOrders().then(
      (result) => setStatus({ tone: "ok", text: `조회로 확인했습니다 · 미체결 ${result.openOrders.length}건, 정리 ${result.cleared}건` }),
      (error: unknown) => setStatus(statusOfFailure(error)),
    ).finally(() => void queryClient.invalidateQueries({ queryKey: ORDER_QUERY_KEY }));
  }, [queryClient]);

  return { status, queued, place, modifyAll, cancelOne, cancelAtPrice, reconcile, say: setStatus };
}
