import { startTransition, useEffect, useMemo, useState } from "react";
import { TODAY_REFETCH_MS, useBookReplayAvailable, useBookReplayDay } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { BarInterval } from "../../chart/crosshairSync";
import { useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref } from "../../stores/ui";
import { REPLAY_REASON, replayDate, replayView, todayRefreshDelayMs, type ReplayView } from "./replay";

const LIVE_VIEW: ReplayView = { kind: "live" };

function readPointedBar(code: SymbolCode, enabled: boolean): BarInterval | null {
  if (!enabled) return null;
  const pointed = useBookReplayStore.getState().pointed;
  return pointed?.symbol === code ? pointed.bar : null;
}

export function useBookReplayEnabled(): boolean {
  const pref = useBookReplayPref();
  return useBookReplayAvailable(pref);
}

export function useBookReplay(code: SymbolCode): ReplayView {
  const enabled = useBookReplayEnabled();
  const [state, setState] = useState<{ code: SymbolCode; bar: BarInterval | null }>(() => ({
    code,
    bar: readPointedBar(code, enabled),
  }));
  useEffect(() => {
    const next = readPointedBar(code, enabled);
    setState((prev) => (prev.code === code && prev.bar === next ? prev : { code, bar: next }));
    if (!enabled) return;
    return useBookReplayStore.subscribe((storeState) => {
      const nextBar = storeState.pointed?.symbol === code ? storeState.pointed.bar : null;
      startTransition(() => {
        setState((prev) => (prev.code === code && prev.bar === nextBar ? prev : { code, bar: nextBar }));
      });
    });
  }, [code, enabled]);
  const bar = enabled && state.code === code ? state.bar : null;
  const serverTimeOrigin = useServerClock((state) => (bar === null ? null : state.serverTimeOrigin));
  const date = bar === null ? null : replayDate(bar);
  const now = Math.floor(serverNow(serverTimeOrigin) / 1000);
  const inProgress = bar !== null && now < bar.end;
  const effectiveNow = bar === null ? now : inProgress ? bar.end - 1 : bar.end;

  const query = useBookReplayDay(code, date, { enabled: enabled && bar !== null });

  const retryDelay = (() => {
    if (!enabled || bar === null || query.isFetching) return null;
    if (query.isError) return Math.max(0, TODAY_REFETCH_MS - Math.max(0, Date.now() - query.errorUpdatedAt));
    if (query.data === undefined) return null;
    return todayRefreshDelayMs(query.data, bar, now, query.dataUpdatedAt, Date.now(), TODAY_REFETCH_MS);
  })();

  useEffect(() => {
    if (retryDelay === null) return;
    if (retryDelay === 0) {
      void query.refetch({ cancelRefetch: false });
      return;
    }
    const timer = window.setTimeout(() => {
      void query.refetch({ cancelRefetch: false });
    }, retryDelay);
    return () => window.clearTimeout(timer);
  }, [retryDelay, query.refetch, query.dataUpdatedAt, query.errorUpdatedAt, bar]);

  return useMemo<ReplayView>(() => {
    if (!enabled || bar === null) return LIVE_VIEW;
    if (query.data !== undefined) return replayView(query.data, bar, effectiveNow);
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    return { kind: "none", reason: REPLAY_REASON.failed };
  }, [enabled, bar, query.isPending, query.data, effectiveNow]);
}
