import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";
import type { PendingState, PendingWrite } from "./pendingWrites";

export const HIGH_VALUE_WON = 100_000_000;

export const orderAmount = (price: number, quantity: number): number => price * quantity;

export const needsHighValueConfirm = (price: number, quantity: number): boolean => orderAmount(price, quantity) >= HIGH_VALUE_WON;

export const SIDE_LABEL: Readonly<Record<OrderSide, string>> = { buy: "매수", sell: "매도" };

export interface PriceGroup {
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly orders: readonly TradingOpenOrder[];
  readonly pending?: PendingState;
}

export const groupKey = (side: OrderSide, price: number): string => `${side}:${price}`;

export function groupOpenOrders(orders: readonly TradingOpenOrder[], code: string): ReadonlyMap<string, PriceGroup> {
  const byKey = new Map<string, TradingOpenOrder[]>();
  for (const order of orders) {
    if (order.code !== code || !(order.openQuantity > 0)) continue;
    const key = groupKey(order.side, order.price);
    byKey.set(key, [...(byKey.get(key) ?? []), order]);
  }
  return new Map([...byKey].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => a.orderNo.localeCompare(b.orderNo));
    const [first] = sorted;
    return [key, { side: first!.side, price: first!.price, quantity: sorted.reduce((sum, order) => sum + order.openQuantity, 0), orders: sorted }];
  }));
}

const PENDING_RANK: Readonly<Record<PendingState, number>> = { sending: 3, canceling: 2, modifying: 1 };

const strongest = (a: PendingState | undefined, b: PendingState): PendingState => (a === undefined || PENDING_RANK[b] > PENDING_RANK[a] ? b : a);

export function groupWithPending(orders: readonly TradingOpenOrder[], writes: readonly PendingWrite[], code: string): ReadonlyMap<string, PriceGroup> {
  const mine = writes.filter((write) => write.code === code);
  const gone = new Set(mine.flatMap((write) => write.kind === "gone" ? [write.orderNo] : []));
  const listed = new Set(orders.map((order) => order.orderNo));
  const visible = [
    ...orders.filter((order) => !gone.has(order.orderNo)),
    ...mine.flatMap((write) => write.kind === "placed" && !listed.has(write.order.orderNo) && !gone.has(write.order.orderNo) ? [write.order] : []),
  ];
  const groups = new Map(groupOpenOrders(visible, code));
  const mark = (key: string, state: PendingState) => {
    const group = groups.get(key);
    if (group) groups.set(key, { ...group, pending: strongest(group.pending, state) });
  };
  const keyOfOrder = (orderNo: string): string | null => {
    const order = visible.find((candidate) => candidate.orderNo === orderNo);
    return order ? groupKey(order.side, order.price) : null;
  };
  for (const write of mine) {
    if (write.kind === "canceling" || write.kind === "modifying") {
      const key = keyOfOrder(write.orderNo);
      if (key !== null) mark(key, write.kind);
    } else if (write.kind === "canceling-price") mark(groupKey(write.side, write.price), "canceling");
  }
  for (const write of mine) {
    if (write.kind !== "sending") continue;
    const key = groupKey(write.side, write.price);
    if (!groups.has(key)) groups.set(key, { side: write.side, price: write.price, quantity: write.quantity, orders: [], pending: "sending" });
  }
  return groups;
}

export interface SideTotal {
  readonly quantity: number;
  readonly count: number;
}

export function sideTotal(groups: ReadonlyMap<string, PriceGroup>, side: OrderSide): SideTotal {
  let quantity = 0;
  let count = 0;
  for (const group of groups.values()) if (group.side === side && group.pending !== "sending") {
    quantity += group.quantity;
    count += group.orders.length;
  }
  return { quantity, count };
}

export type DragSource =
  | { readonly kind: "chip"; readonly group: PriceGroup }
  | { readonly kind: "order"; readonly order: TradingOpenOrder }
  | { readonly kind: "total"; readonly side: OrderSide; readonly groups: readonly PriceGroup[] };

export type DragTarget =
  | { readonly kind: "cell"; readonly side: OrderSide; readonly price: number }
  | { readonly kind: "ladder" }
  | { readonly kind: "origin" }
  | { readonly kind: "outside" };

export type DragOutcome =
  | { readonly kind: "modify"; readonly price: number }
  | { readonly kind: "cancel" }
  | { readonly kind: "abort" };

export interface DragJudgement {
  readonly source: DragSource;
  readonly target: DragTarget;
  readonly escaped: boolean;
}

export const dragSide = (source: DragSource): OrderSide =>
  source.kind === "chip" ? source.group.side : source.kind === "order" ? source.order.side : source.side;

export const dragQuantity = (source: DragSource): number =>
  source.kind === "chip" ? source.group.quantity : source.kind === "order" ? source.order.openQuantity : source.groups.reduce((sum, group) => sum + group.quantity, 0);

const dragOrderCount = (source: DragSource): number =>
  source.kind === "chip" ? source.group.orders.length : source.kind === "order" ? 1 : source.groups.reduce((sum, group) => sum + group.orders.length, 0);

export function judgeDrag({ source, target, escaped }: DragJudgement): DragOutcome {
  if (escaped) return { kind: "abort" };
  if (target.kind === "outside") return { kind: "cancel" };
  if (source.kind === "total") return { kind: "abort" };
  const { side, price } = source.kind === "chip" ? source.group : source.order;
  if (target.kind === "cell" && target.side === side && target.price !== price) return { kind: "modify", price: target.price };
  return { kind: "abort" };
}

export function dragGhostText(target: DragTarget, source: DragSource): string {
  const outcome = judgeDrag({ source, target, escaped: false });
  if (outcome.kind === "modify") return `→ ${formatPrice(outcome.price, false)}원`;
  if (outcome.kind === "abort") return "";
  if (source.kind === "chip") return `놓으면 ${formatPrice(source.group.price, false)}원 ${SIDE_LABEL[source.group.side]} ${dragOrderCount(source)}건 취소`;
  if (source.kind === "order") return "놓으면 이 주문 취소";
  return `놓으면 ${SIDE_LABEL[source.side]} ${dragOrderCount(source)}건 모두 취소`;
}

export const previewText = (side: OrderSide, quantity: number): string => `${SIDE_LABEL[side]} ${quantity}`;

export type QuantityMode = "shares" | "amount";

export function quantityOf(mode: QuantityMode, input: number, price: number): number {
  if (!Number.isFinite(input) || input <= 0) return 0;
  if (mode === "shares") return Math.floor(input);
  return price > 0 ? Math.floor(input / price) : 0;
}

export interface Capacity {
  readonly sellableQuantity: number | null;
  readonly buyableAmount: number | null;
}

export function capacityProblem(side: OrderSide, price: number, quantity: number, capacity: Capacity): string | null {
  if (!(quantity > 0)) return "수량을 입력하세요";
  if (side === "sell" && capacity.sellableQuantity !== null && quantity > capacity.sellableQuantity) return `매도 가능 수량(${capacity.sellableQuantity.toLocaleString("ko-KR")})을 넘습니다`;
  if (side === "buy" && capacity.buyableAmount !== null && orderAmount(price, quantity) > capacity.buyableAmount) return `매수 가능 금액 ${capacity.buyableAmount.toLocaleString("ko-KR")}원을 넘습니다`;
  return null;
}
