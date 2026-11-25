import { startTransition, useEffect, useState } from "react";
import type { Period } from "../../api/generated/Period";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isIntraday } from "../../chart/time";
import { type ChartPointer, useChartPointerStore } from "../../stores/chartPointer";
import { kstDateOf } from "./history";

export type BrokerSyncTarget =
  | { readonly kind: "off" }
  | { readonly kind: "waiting" }
  | { readonly kind: "unsupported"; readonly period: Period }
  | {
      readonly kind: "synced";
      readonly date: string;
      readonly isToday: boolean;
      readonly cursor: UnixSeconds | null;
      readonly period: Period;
      readonly close: number | null;
    };

export function resolveBrokerSyncTarget(
  enabled: boolean,
  code: SymbolCode,
  pointed: ChartPointer | null,
  nowMs: number,
): BrokerSyncTarget {
  if (!enabled) return { kind: "off" };
  if (pointed === null || pointed.symbol !== code) return { kind: "waiting" };
  const { bar, close } = pointed;
  const today = kstDateOf(nowMs);
  if (bar.period === "D") {
    const date = kstDateOf(bar.start * 1000);
    return { kind: "synced", date, isToday: date === today, cursor: null, period: "D", close };
  }
  if (isIntraday(bar.period)) {
    const at = bar.end - 1;
    const date = kstDateOf(at * 1000);
    const nowSec = Math.floor(nowMs / 1000);
    const cursor = nowSec < bar.end ? null : at;
    return { kind: "synced", date, isToday: date === today, cursor, period: bar.period, close };
  }
  return { kind: "unsupported", period: bar.period };
}

export function gapContaining(
  gaps: readonly (readonly [UnixSeconds, UnixSeconds])[],
  t: UnixSeconds | null,
): readonly [UnixSeconds, UnixSeconds] | null {
  if (t === null) return null;
  for (const gap of gaps) {
    if (t >= gap[0] && t <= gap[1]) return gap;
  }
  return null;
}

function readPointer(code: SymbolCode, enabled: boolean): ChartPointer | null {
  if (!enabled) return null;
  const pointed = useChartPointerStore.getState().pointed;
  return pointed?.symbol === code ? pointed : null;
}

export function useBrokerChartPointer(code: SymbolCode, enabled: boolean): ChartPointer | null {
  const [state, setState] = useState<{ code: SymbolCode; pointed: ChartPointer | null }>(() => ({
    code,
    pointed: readPointer(code, enabled),
  }));

  useEffect(() => {
    if (!enabled) {
      setState((prev) => (prev.code === code && prev.pointed === null ? prev : { code, pointed: null }));
      return;
    }
    const store = useChartPointerStore.getState();
    store.addBrokerSync(code);
    const initial = readPointer(code, true);
    setState((prev) => (prev.code === code && prev.pointed === initial ? prev : { code, pointed: initial }));
    const unsubscribe = useChartPointerStore.subscribe((storeState) => {
      const next = storeState.pointed?.symbol === code ? storeState.pointed : null;
      startTransition(() => {
        setState((prev) => (prev.code === code && prev.pointed === next ? prev : { code, pointed: next }));
      });
    });
    return () => {
      unsubscribe();
      useChartPointerStore.getState().removeBrokerSync(code);
    };
  }, [code, enabled]);

  return enabled && state.code === code ? state.pointed : null;
}
