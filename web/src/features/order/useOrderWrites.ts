import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrderCommands } from "../../api/generated/OrderCommands";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import { actionInAccount, cancelAction, cancelBatchAction, createLedger, modifyAction, newIdFor, placeAction, type Settlement } from "./commandLedger";
import type { CurrentAccount } from "./orderAccount";
import { cancelOrder, cancelOrdersAtPrice, modifyOrder, placeOrder, reconcileOrders } from "./orderApi";
import { needsHighValueConfirm } from "./orderRules";
import { type PendingDraft, pendingWrites } from "./pendingWrites";
import { isUnanswered, type OrderStatus, statusOfCanceling, statusOfCommand, statusOfFailure, statusOfModifying, statusOfSending, withMargin } from "./statusText";

const OK_STATUS_MS = 4_000;

export const ORDER_QUERY_KEY = ["order"] as const;

const accountField = (ref: string | null): { account?: string } => (ref === null ? {} : { account: ref });

const ledger = createLedger(newIdFor);
let placeSequence = 0;

export function statusOfBatch(result: OrderCommands): OrderStatus {
  if (result.commands.length === 0) return { tone: "info", text: "취소할 주문이 없습니다" };
  const worst = result.commands.find((c) => c.state === "unknown") ?? result.commands.find((c) => c.state === "rejected") ?? result.commands[0]!;
  const done = result.commands.filter((c) => c.state === "accepted").length;
  if (worst.state === "accepted") return { tone: "ok", text: `취소 접수 · ${done}건` };
  const status = statusOfCommand(worst);
  return done > 0 ? { ...status, text: `${status.text} (접수 ${done}건)` } : status;
}

interface Plan<T> {
  readonly action: string;
  readonly mark: Extract<PendingDraft, { readonly key: string }>;
  readonly starting: OrderStatus;
  readonly coalesce: boolean;
  call(id: string): Promise<T>;
  describe(result: T): OrderStatus;
  settled(result: T): readonly PendingDraft[];
}

const acceptedOrderNo = (command: OrderCommand): string | null => command.state === "accepted" ? command.orderNo : null;

export interface PlaceRequest {
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly confirmHighValue: boolean;
  readonly margin?: number;
}

export interface OrderWrites {
  readonly status: OrderStatus | null;
  readonly queued: number;
  place(request: PlaceRequest): void;
  modifyAll(orders: readonly TradingOpenOrder[], price: number): void;
  cancelOne(orderNo: string): void;
  cancelAtPrice(side: OrderSide, price: number): void;
  reconcile(): void;
  say(status: OrderStatus): void;
  dismiss(): void;
}

const openOrderOf = (orderNo: string, code: string, venue: Venue, side: OrderSide, price: number, quantity: number): TradingOpenOrder =>
  ({ orderNo, code, name: "", side, quantity, price, openQuantity: quantity, status: "접수", orderedAt: "", originalOrderNo: null, venue });

export function useOrderWrites(account: CurrentAccount | null, code: string, venue: Venue): OrderWrites {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    if (status?.tone !== "ok" && status?.fades !== true) return;
    const timer = setTimeout(() => setStatus(null), OK_STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const tail = useRef<Promise<void>>(Promise.resolve());
  const accountRef = account?.ref ?? null;
  const writeScope = `${account?.state ?? ""}|${accountRef ?? ""}`;
  useEffect(() => () => pendingWrites.clear(code), [code, writeScope]);

  const enqueue = useCallback(<T,>(plan: Plan<T>) => {
    const ledgerKey = actionInAccount(plan.action, accountRef);
    const coalesced = plan.coalesce ? ledger.issue(ledgerKey) : null;
    if (coalesced && !coalesced.send) return;
    const commandId = coalesced?.id ?? ledger.issueEach(ledgerKey);
    pendingWrites.begin(plan.mark);
    setQueued((n) => n + 1);
    tail.current = tail.current.then(async () => {
      let settlement: Settlement = "answered";
      setStatus(plan.starting);
      try {
        const result = await plan.call(commandId);
        pendingWrites.resolve(plan.mark.key, plan.settled(result));
        setStatus(plan.describe(result));
      } catch (error) {
        if (isUnanswered(error)) settlement = "unanswered";
        setStatus(statusOfFailure(error));
      } finally {
        pendingWrites.resolve(plan.mark.key, []);
        if (coalesced) ledger.settle(ledgerKey, settlement);
        else ledger.settleEach(ledgerKey, commandId, settlement);
        setQueued((n) => n - 1);
        void queryClient.invalidateQueries({ queryKey: ORDER_QUERY_KEY });
      }
    });
  }, [queryClient, accountRef]);

  const place = useCallback((r: PlaceRequest) => {
    const action = placeAction(code, r.side, r.price, r.quantity, venue);
    enqueue<OrderCommand>({
      action,
      coalesce: false,
      mark: { kind: "sending", key: `${action}|${++placeSequence}`, code, side: r.side, price: r.price, quantity: r.quantity },
      starting: statusOfSending(r.side, r.quantity, r.price),
      call: (commandId) => placeOrder({ ...accountField(accountRef), commandId, code, side: r.side, quantity: r.quantity, price: r.price, venue, confirmHighValue: r.confirmHighValue }),
      describe: (command) => withMargin(statusOfCommand(command), r.margin ?? 0),
      settled: (command) => {
        const orderNo = acceptedOrderNo(command);
        return orderNo === null ? [] : [{ kind: "placed", code, order: openOrderOf(orderNo, code, venue, r.side, r.price, r.quantity) }];
      },
    });
  }, [code, venue, enqueue, accountRef]);

  const modifyAll = useCallback((targets: readonly TradingOpenOrder[], price: number) => {
    for (const order of targets) {
      const action = modifyAction(order.orderNo, price);
      enqueue<OrderCommand>({
        action,
        coalesce: true,
        mark: { kind: "modifying", key: action, code, orderNo: order.orderNo },
        starting: statusOfModifying(order.price, price),
        call: (commandId) => modifyOrder({ ...accountField(accountRef), commandId, orderNo: order.orderNo, price, confirmHighValue: needsHighValueConfirm(price, order.openQuantity) }),
        describe: statusOfCommand,
        settled: (command) => {
          if (command.state !== "accepted") return [];
          const replaced: PendingDraft = { kind: "gone", code, orderNo: order.orderNo };
          return command.orderNo === null ? [replaced] : [replaced, { kind: "placed", code, replaces: order.orderNo, order: openOrderOf(command.orderNo, code, order.venue, order.side, price, order.openQuantity) }];
        },
      });
    }
  }, [code, enqueue, accountRef]);

  const cancelOne = useCallback((orderNo: string) => {
    const action = cancelAction(orderNo);
    enqueue<OrderCommand>({
      action,
      coalesce: true,
      mark: { kind: "canceling", key: action, code, orderNo },
      starting: statusOfCanceling(),
      call: (commandId) => cancelOrder({ ...accountField(accountRef), commandId, orderNo }),
      describe: statusOfCommand,
      settled: (command) => command.state === "accepted" ? [{ kind: "gone", code, orderNo }] : [],
    });
  }, [code, enqueue, accountRef]);

  const cancelAtPrice = useCallback((side: OrderSide, price: number) => {
    const action = cancelBatchAction(code, side, price);
    enqueue<OrderCommands>({
      action,
      coalesce: true,
      mark: { kind: "canceling-price", key: action, code, side, price },
      starting: statusOfCanceling({ side, price }),
      call: (batchId) => cancelOrdersAtPrice({ ...accountField(accountRef), batchId, code, side, price }),
      describe: statusOfBatch,
      settled: (result) => result.commands.flatMap((command) => command.state === "accepted" && command.targetOrderNo !== null ? [{ kind: "gone", code, orderNo: command.targetOrderNo } satisfies PendingDraft] : []),
    });
  }, [code, enqueue, accountRef]);

  const reconcile = useCallback(() => {
    reconcileOrders(accountRef).then(
      (result) => setStatus({ tone: "ok", text: `조회로 확인했습니다 · 미체결 ${result.openOrders.length}건, 정리 ${result.cleared}건` }),
      (error: unknown) => setStatus(statusOfFailure(error)),
    ).finally(() => void queryClient.invalidateQueries({ queryKey: ORDER_QUERY_KEY }));
  }, [queryClient, accountRef]);

  return { status, queued, place, modifyAll, cancelOne, cancelAtPrice, reconcile, say: setStatus, dismiss: () => setStatus(null) };
}
