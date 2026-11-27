import type { OrderSide } from "../../api/generated/OrderSide";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { Venue } from "../../api/generated/Venue";
import { formatPrice } from "../../lib/format";
import { formatQuantity } from "../market-window/format";
import type { HighValueRequest } from "./HighValueConfirm";
import { ETF_ETN_AFTER_HOURS_TEXT, isEtfOrEtnAfterHours, sellQuantityAtPrice } from "./holdingSummary";
import { withDirectionJosa } from "./josa";
import { accountNumberText, type CurrentAccount } from "./orderAccount";
import {
  buyBlock,
  buyRatioLabel,
  type BuyRatioPercent,
  type Capacity,
  capacityProblem,
  type DragOutcome,
  type DragSource,
  marginOf,
  modifyBuyProblem,
  needsHighValueConfirm,
  orderAmount,
  orderQuantityForPrice,
  planCancel,
  type PriceGroup,
  type PriceKey,
} from "./orderRules";
import { routeLabel } from "./orderSettings";
import type { PendingWrite } from "./pendingWrites";
import { CANCEL_REFUSAL, type OrderStatus, REJECT_TEXT, statusOfReplayLocked } from "./statusText";
import type { PlaceRequest } from "./useOrderWrites";

export interface OrderCommandContext {
  readonly code: SymbolCode;
  readonly symbolInfo: SymbolInfo | undefined;
  readonly currentAccount: CurrentAccount | null;
  readonly orderVenue: Venue;
  readonly mock: boolean;
  readonly nxtNotTraded: boolean;
  readonly replayLocked: boolean;
  readonly quantity: number;
  readonly buyRatio?: BuyRatioPercent | null;
  readonly keepLastEntry: boolean;
  readonly capacity: Capacity;
  readonly groups: ReadonlyMap<string, PriceGroup>;
  readonly openOrdersListedAt: number;
}

export interface OrderCommandSink {
  readonly place: (request: PlaceRequest) => void;
  readonly modifyAll: (orders: readonly TradingOpenOrder[], price: number) => void;
  readonly cancelOne: (orderNo: string) => void;
  readonly cancelAtPrice: (side: OrderSide, price: number) => void;
  readonly say: (status: OrderStatus) => void;
  readonly setConfirm: (request: HighValueRequest) => void;
  readonly rememberEntry: (quantity: number, usedAt: number) => void;
  readonly clearBuyRatio: () => void;
  readonly disableBookReplay: () => void;
  readonly readPending: () => readonly PendingWrite[];
  readonly nowMs: () => number;
}

export interface OrderCommands {
  readonly place: (side: OrderSide, price: number, cappedQuantity?: number) => void;
  readonly modifyOrders: (side: OrderSide, price: number, orders: readonly TradingOpenOrder[], to: number) => void;
  readonly cancelOne: (orderNo: string) => void;
  readonly cancelGroups: (keys: readonly PriceKey[]) => void;
  readonly drop: (source: DragSource, outcome: DragOutcome) => void;
  readonly notifyReplayLocked: () => void;
}

export function createOrderCommands(readContext: () => OrderCommandContext, sink: OrderCommandSink): OrderCommands {
  const notifyReplayLocked = (): void => {
    sink.say(statusOfReplayLocked(sink.disableBookReplay));
  };

  const guardReplayLock = (action: () => void): void => {
    if (readContext().replayLocked) {
      notifyReplayLocked();
      return;
    }
    action();
  };

  const confirmContext = (ctx: OrderCommandContext, route: string) => ({
    name: ctx.symbolInfo?.name ?? ctx.code,
    code: ctx.code,
    account: accountNumberText(ctx.currentAccount?.broker ?? "kiwoom", ctx.currentAccount?.tail ?? null),
    route,
    mock: ctx.mock,
  });

  const submit = (ctx: OrderCommandContext, side: OrderSide, price: number, quantity: number, usedBuyRatio: boolean) => {
    const margin = side === "buy" ? marginOf(orderAmount(price, quantity), ctx.capacity.buying) : 0;
    const send = (confirmHighValue: boolean) => {
      guardReplayLock(() => {
        const latest = readContext();
        const listedWhenIn =
          side === "sell" ? sellQuantityAtPrice(latest.groups, sink.readPending(), latest.code, price, latest.openOrdersListedAt) + quantity : 0;
        sink.place({ side, price, quantity, confirmHighValue, margin, listedWhenIn });
        if (usedBuyRatio) sink.clearBuyRatio();
        else if (latest.keepLastEntry) sink.rememberEntry(quantity, sink.nowMs());
      });
    };
    if (needsHighValueConfirm(price, quantity)) {
      sink.setConfirm({
        ...confirmContext(ctx, routeLabel(ctx.orderVenue)),
        side,
        verb: "주문",
        detail: `${formatQuantity(quantity)} · ${formatPrice(price, false)}원`,
        amount: price * quantity,
        run: () => send(true),
      });
    } else {
      send(false);
    }
  };

  const place = (side: OrderSide, price: number, cappedQuantity?: number) => {
    guardReplayLock(() => {
      const ctx = readContext();
      if (ctx.nxtNotTraded) {
        sink.say({ tone: "error", text: REJECT_TEXT.nxt_unavailable });
        return;
      }
      if (isEtfOrEtnAfterHours(Math.floor(sink.nowMs() / 1000), ctx.symbolInfo ?? null)) {
        sink.say({ tone: "error", text: ETF_ETN_AFTER_HOURS_TEXT });
        return;
      }
      const activeBuyRatio = cappedQuantity === undefined && side === "buy" ? (ctx.buyRatio ?? null) : null;
      const dynamicBuyRatio = activeBuyRatio !== null && ctx.capacity.buying !== null;
      const orderQuantity = cappedQuantity ?? orderQuantityForPrice(side, price, ctx.quantity, ctx.capacity.buying, activeBuyRatio);
      if (dynamicBuyRatio && orderQuantity === 0) {
        const block = buyBlock(price, 1, ctx.capacity.buying);
        if (block) {
          sink.say({ tone: "error", text: block.text });
          return;
        }
        sink.say({ tone: "error", text: `${buyRatioLabel(activeBuyRatio)} 계산 결과가 1주 미만입니다` });
        return;
      }
      const problem = capacityProblem(side, orderQuantity, ctx.capacity);
      if (problem) {
        sink.say({ tone: "error", text: problem });
        return;
      }
      const block = side === "buy" ? buyBlock(price, orderQuantity, ctx.capacity.buying) : null;
      if (block) {
        sink.say({
          tone: "error",
          text: block.text,
          action: block.maxQuantity > 0 ? { label: `${withDirectionJosa(block.maxQuantity)} 보내기`, run: () => place(side, price, block.maxQuantity) } : undefined,
        });
        return;
      }
      submit(ctx, side, price, orderQuantity, dynamicBuyRatio);
    });
  };

  const modifyOrders = (side: OrderSide, price: number, orders: readonly TradingOpenOrder[], to: number) => {
    guardReplayLock(() => {
      const ctx = readContext();
      const totalOpen = orders.reduce((sum, order) => sum + order.openQuantity, 0);
      const problem = side === "buy" ? modifyBuyProblem(price, to, totalOpen, ctx.capacity.buying) : null;
      if (problem) {
        sink.say({ tone: "error", text: problem });
        return;
      }
      const run = () => {
        guardReplayLock(() => {
          sink.modifyAll(orders, to);
        });
      };
      if (orders.some((order) => needsHighValueConfirm(to, order.openQuantity))) {
        sink.setConfirm({
          ...confirmContext(ctx, [...new Set(orders.map((order) => routeLabel(order.venue)))].join("·")),
          side,
          verb: "정정",
          detail: `${formatPrice(price, false)}원 → ${formatPrice(to, false)}원`,
          amount: to * totalOpen,
          run,
        });
      } else {
        run();
      }
    });
  };

  const cancelGroups = (keys: readonly PriceKey[]) => {
    guardReplayLock(() => {
      const ctx = readContext();
      const plan = planCancel(ctx.groups, sink.readPending(), ctx.code, keys);
      if (plan.kind === "ready") plan.targets.forEach((group) => sink.cancelAtPrice(group.side, group.price));
      else sink.say(CANCEL_REFUSAL[plan.kind]);
    });
  };

  const cancelOne = (orderNo: string) => {
    guardReplayLock(() => sink.cancelOne(orderNo));
  };

  const drop = (source: DragSource, outcome: DragOutcome) => {
    if (outcome.kind === "abort") return;
    guardReplayLock(() => {
      if (source.kind === "chip") {
        if (outcome.kind === "cancel") cancelGroups([source.group]);
        else modifyOrders(source.group.side, source.group.price, source.group.orders, outcome.price);
      } else if (source.kind === "order") {
        if (outcome.kind === "cancel") sink.cancelOne(source.order.orderNo);
        else modifyOrders(source.order.side, source.order.price, [source.order], outcome.price);
      } else {
        cancelGroups(source.groups);
      }
    });
  };

  return { place, modifyOrders, cancelOne, cancelGroups, drop, notifyReplayLocked };
}
