import type { TradingExecution } from "../../api/generated/TradingExecution";

const clockKey = (time: string): string | null => {
  const trimmed = time.trim();
  if (/^\d{6}$/.test(trimmed)) return trimmed;
  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed.replaceAll(":", "");
  return null;
};

export function newestFirst(executions: readonly TradingExecution[]): TradingExecution[] {
  const timed: { readonly fill: TradingExecution; readonly clock: string }[] = [];
  const untimed: TradingExecution[] = [];
  for (const fill of executions) {
    const clock = clockKey(fill.time);
    if (clock === null) untimed.push(fill);
    else timed.push({ fill, clock });
  }
  const byRecency = (a: { readonly fill: TradingExecution; readonly clock: string }, b: { readonly fill: TradingExecution; readonly clock: string }) =>
    a.clock !== b.clock ? (a.clock < b.clock ? 1 : -1) : a.fill.orderNo === b.fill.orderNo ? 0 : orderNoValue(b.fill.orderNo) - orderNoValue(a.fill.orderNo);
  return [...timed.sort(byRecency).map((entry) => entry.fill), ...untimed];
}

function orderNoValue(orderNo: string): number {
  const value = Number(orderNo);
  return Number.isNaN(value) ? 0 : value;
}
