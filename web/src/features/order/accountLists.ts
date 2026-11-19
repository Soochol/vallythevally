import type { TradingExecution } from "../../api/generated/TradingExecution";

const HAS_CLOCK_TIME = /^\d{6}$/;

export function newestFirst(executions: readonly TradingExecution[]): TradingExecution[] {
  const timed = executions.filter((fill) => HAS_CLOCK_TIME.test(fill.time));
  const untimed = executions.filter((fill) => !HAS_CLOCK_TIME.test(fill.time));
  const byRecency = (a: TradingExecution, b: TradingExecution) =>
    a.time !== b.time ? (a.time < b.time ? 1 : -1) : a.orderNo === b.orderNo ? 0 : orderNoValue(b.orderNo) - orderNoValue(a.orderNo);
  return [...timed.sort(byRecency), ...untimed];
}

function orderNoValue(orderNo: string): number {
  const value = Number(orderNo);
  return Number.isNaN(value) ? 0 : value;
}
