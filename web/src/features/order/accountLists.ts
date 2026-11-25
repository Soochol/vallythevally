import type { TradingExecution } from "../../api/generated/TradingExecution";

const clockKey = (time: string): string | null => {
  const trimmed = time.trim();
  if (/^\d{6}$/.test(trimmed)) return trimmed;
  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed.replaceAll(":", "");
  return null;
};

export function newestFirst<T extends Pick<TradingExecution, "orderNo" | "time">>(executions: readonly T[]): T[] {
  const timed: { readonly fill: T; readonly clock: string }[] = [];
  const untimed: T[] = [];
  for (const fill of executions) {
    const clock = clockKey(fill.time);
    if (clock === null) untimed.push(fill);
    else timed.push({ fill, clock });
  }
  const byRecency = (a: { readonly fill: T; readonly clock: string }, b: { readonly fill: T; readonly clock: string }) =>
    a.clock !== b.clock ? (a.clock < b.clock ? 1 : -1) : a.fill.orderNo === b.fill.orderNo ? 0 : orderNoValue(b.fill.orderNo) - orderNoValue(a.fill.orderNo);
  return [...timed.sort(byRecency).map((entry) => entry.fill), ...untimed];
}

export type FillIdentity = Pick<TradingExecution, "orderNo" | "code" | "side" | "time" | "price" | "quantity">;

export function fillIdentityKey(fill: FillIdentity): string {
  return `${fill.orderNo}:${fill.code}:${fill.side}:${fill.time}:${fill.price}:${fill.quantity}`;
}

export function keyNewestFirstFills<T extends FillIdentity>(orderedNewestFirst: readonly T[]): { readonly item: T; readonly key: string }[] {
  const counts = new Map<string, number>();
  const keys = new Array<string>(orderedNewestFirst.length);
  for (let index = orderedNewestFirst.length - 1; index >= 0; index -= 1) {
    const base = fillIdentityKey(orderedNewestFirst[index]!);
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    keys[index] = `${base}#${ordinal}`;
  }
  return orderedNewestFirst.map((item, index) => ({ item, key: keys[index]! }));
}

function orderNoValue(orderNo: string): number {
  const value = Number(orderNo);
  return Number.isNaN(value) ? 0 : value;
}
