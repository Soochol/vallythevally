import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { formatPrice } from "../../lib/format";
import type { PendingState, PendingWrite } from "./pendingWrites";

export const HIGH_VALUE_WON = 100_000_000;

export const orderAmount = (price: number, quantity: number): number => price * quantity;

export const needsHighValueConfirm = (price: number, quantity: number): boolean => orderAmount(price, quantity) >= HIGH_VALUE_WON;

export const SIDE_LABEL: Readonly<Record<OrderSide, string>> = { buy: "매수", sell: "매도" };

export const CANCEL_CONFIRM_MS = 3_000;

export const CANCEL_CONFIRM_FROM = 2;

export const needsCancelConfirm = (orderCount: number): boolean => orderCount >= CANCEL_CONFIRM_FROM;

export const cancelConfirmText = (orderCount: number): string => `${orderCount}건 취소 · 한 번 더 누르기`;

export const orderCountOf = (groups: readonly { readonly orders: readonly unknown[] }[]): number => groups.reduce((sum, group) => sum + group.orders.length, 0);

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
  const sendingOnly = new Map<string, PriceGroup>();
  for (const write of mine) {
    if (write.kind !== "sending") continue;
    const key = groupKey(write.side, write.price);
    if (groups.has(key)) continue;
    const sent = sendingOnly.get(key);
    sendingOnly.set(key, { side: write.side, price: write.price, quantity: (sent?.quantity ?? 0) + write.quantity, orders: [], pending: "sending" });
  }
  for (const [key, group] of sendingOnly) groups.set(key, group);
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

export const dragOrderCount = (source: DragSource): number =>
  source.kind === "chip" ? source.group.orders.length : source.kind === "order" ? 1 : source.groups.reduce((sum, group) => sum + group.orders.length, 0);

export function judgeDrag({ source, target, escaped }: DragJudgement): DragOutcome {
  if (escaped) return { kind: "abort" };
  if (target.kind === "outside") return { kind: "cancel" };
  if (source.kind === "total") return { kind: "abort" };
  const { side, price } = source.kind === "chip" ? source.group : source.order;
  if (target.kind === "cell" && target.side === side && target.price !== price) return { kind: "modify", price: target.price };
  return { kind: "abort" };
}

export const dragCancels = (target: DragTarget, source: DragSource): boolean => judgeDrag({ source, target, escaped: false }).kind === "cancel";

export function dragGhostText(target: DragTarget, source: DragSource): string {
  const outcome = judgeDrag({ source, target, escaped: false });
  if (outcome.kind === "modify") return `→ ${formatPrice(outcome.price, false)}원`;
  if (outcome.kind === "abort") return "";
  if (source.kind === "chip") return `놓으면 ${formatPrice(source.group.price, false)}원 ${SIDE_LABEL[source.group.side]} ${dragOrderCount(source)}건 취소`;
  if (source.kind === "order") return "놓으면 이 주문 취소";
  return `놓으면 ${SIDE_LABEL[source.side]} ${dragOrderCount(source)}건 모두 취소`;
}

export const previewText = (side: OrderSide, quantity: number): string => `${SIDE_LABEL[side]} ${quantity}`;

export const addQuantityText = (quantity: number): string => `＋${quantity}`;

export function typedQuantity(input: string): number {
  const typed = Number(input);
  return Number.isFinite(typed) && typed > 0 ? Math.floor(typed) : 0;
}

export const quantityForAmount = (amount: number, price: number | null): number | null => (price !== null && price > 0 ? Math.floor(amount / price) : null);

export interface BuyingPower {
  readonly policy: MarginPolicy;
  readonly amount: number;
  readonly cashAmount: number;
}

export interface Capacity {
  readonly sellableQuantity: number | null;
  readonly buying: BuyingPower | null;
}

export const buyingPowerOf = (orderable: TradingOrderable | null): BuyingPower | null =>
  orderable === null ? null : { policy: orderable.policy, amount: orderable.amount, cashAmount: orderable.cashAmount };

export const maxBuyQuantity = (price: number, amount: number): number => (price > 0 ? Math.floor(amount / price) : 0);

const LIMIT_NAME: Readonly<Record<MarginPolicy, string>> = { cash_only: "현금 주문가능", allow_margin: "미수 포함 주문가능" };

export const marginOf = (won: number, buying: BuyingPower | null): number =>
  buying !== null && buying.policy === "allow_margin" ? Math.max(0, won - buying.cashAmount) : 0;

export type BuyPreview = "over" | "margin";

export function buyPreview(price: number, quantity: number, buying: BuyingPower | null): BuyPreview | null {
  if (buying === null || !(quantity > 0)) return null;
  const won = orderAmount(price, quantity);
  if (won > buying.amount) return "over";
  return marginOf(won, buying) > 0 ? "margin" : null;
}

export interface BuyBlock {
  readonly text: string;
  readonly maxQuantity: number;
}

const overText = (buying: BuyingPower): string =>
  `${LIMIT_NAME[buying.policy]} ${buying.amount.toLocaleString("ko-KR")}원을 넘습니다${buying.policy === "cash_only" ? " (미수 막음)" : ""}`;

export function buyBlock(price: number, quantity: number, buying: BuyingPower | null): BuyBlock | null {
  if (buyPreview(price, quantity, buying) !== "over") return null;
  const maxQuantity = maxBuyQuantity(price, buying!.amount);
  return { text: `${overText(buying!)} · ${maxQuantity > 0 ? `최대 ${maxQuantity.toLocaleString("ko-KR")}` : "살 수 있는 수량이 없습니다"}`, maxQuantity };
}

export function modifyBuyProblem(fromPrice: number, toPrice: number, openQuantity: number, buying: BuyingPower | null): string | null {
  if (buying === null || toPrice <= fromPrice) return null;
  const added = (toPrice - fromPrice) * openQuantity;
  return added > buying.amount ? `정정으로 늘어난 ${added.toLocaleString("ko-KR")}원이 ${overText(buying)}` : null;
}

export interface EstimateNote {
  readonly tone: BuyPreview;
  readonly text: string;
}

export function estimateNote(won: number, buying: BuyingPower | null): EstimateNote | null {
  if (buying === null) return null;
  if (won > buying.amount) {
    const over = (won - buying.amount).toLocaleString("ko-KR");
    return { tone: "over", text: buying.policy === "cash_only" ? `현금 ${over}원 초과` : `미수 포함 한도 ${over}원 초과` };
  }
  const margin = marginOf(won, buying);
  return margin > 0 ? { tone: "margin", text: `미수 약 ${margin.toLocaleString("ko-KR")}원 생김` } : null;
}

export function capacityProblem(side: OrderSide, quantity: number, capacity: Capacity): string | null {
  if (!(quantity > 0)) return "수량을 입력하세요";
  if (side === "sell" && capacity.sellableQuantity !== null && quantity > capacity.sellableQuantity) return `매도 가능 수량(${capacity.sellableQuantity.toLocaleString("ko-KR")})을 넘습니다`;
  return null;
}
