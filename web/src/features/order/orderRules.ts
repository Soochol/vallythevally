import type { OrderSide } from "../../api/generated/OrderSide";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import { formatPrice } from "../../lib/format";

export const HIGH_VALUE_WON = 100_000_000;

export const orderAmount = (price: number, quantity: number): number => price * quantity;

export const needsHighValueConfirm = (price: number, quantity: number): boolean => orderAmount(price, quantity) >= HIGH_VALUE_WON;

export const SIDE_LABEL: Readonly<Record<OrderSide, string>> = { buy: "매수", sell: "매도" };

export interface PriceGroup {
  readonly side: OrderSide;
  readonly price: number;
  readonly quantity: number;
  readonly orders: readonly TradingOpenOrder[];
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

export interface SideTotal {
  readonly quantity: number;
  readonly count: number;
}

export function sideTotal(groups: ReadonlyMap<string, PriceGroup>, side: OrderSide): SideTotal {
  let quantity = 0;
  let count = 0;
  for (const group of groups.values()) if (group.side === side) {
    quantity += group.quantity;
    count += group.orders.length;
  }
  return { quantity, count };
}

export type DragTarget =
  | { readonly kind: "cell"; readonly side: OrderSide; readonly price: number }
  | { readonly kind: "ladder" }
  | { readonly kind: "outside" };

export type DragOutcome =
  | { readonly kind: "modify"; readonly price: number }
  | { readonly kind: "cancel" }
  | { readonly kind: "abort" };

export interface DragJudgement {
  readonly chipSide: OrderSide;
  readonly chipPrice: number;
  readonly target: DragTarget;
  readonly escaped: boolean;
}

export function judgeDrag({ chipSide, chipPrice, target, escaped }: DragJudgement): DragOutcome {
  if (escaped) return { kind: "abort" };
  if (target.kind === "outside") return { kind: "cancel" };
  if (target.kind === "cell" && target.side === chipSide && target.price !== chipPrice) return { kind: "modify", price: target.price };
  return { kind: "abort" };
}

export const dragGhostText = (target: DragTarget, chip: { side: OrderSide; price: number }): string => {
  if (target.kind === "outside") return "놓으면 취소";
  if (target.kind === "cell" && target.side === chip.side && target.price !== chip.price) return `→ ${formatPrice(target.price, false)}원`;
  return "";
};

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
