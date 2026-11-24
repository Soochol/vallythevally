import { useEffect, useMemo } from "react";
import { TODAY_REFETCH_MS, useBookReplayAvailable, useBookReplayDay } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref } from "../../stores/ui";
import { REPLAY_REASON, replayDate, replayView, todayRefreshDelayMs, type ReplayView } from "./replay";

const LIVE_VIEW: ReplayView = { kind: "live" };

export function useBookReplayEnabled(): boolean {
  const pref = useBookReplayPref();
  return useBookReplayAvailable(pref);
}

export function useBookReplay(code: SymbolCode): ReplayView {
  const enabled = useBookReplayEnabled();
  const bar = useBookReplayStore((state) => (enabled && state.pointed?.symbol === code ? state.pointed.bar : null));
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
      void query.refetch();
      return;
    }
    const timer = window.setTimeout(() => {
      void query.refetch();
    }, retryDelay);
    return () => window.clearTimeout(timer);
  }, [retryDelay, query.refetch, query.dataUpdatedAt, query.errorUpdatedAt, bar]);

  return useMemo<ReplayView>(() => {
    if (!enabled || bar === null) return LIVE_VIEW;
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    if (query.isError || query.data === undefined) return { kind: "none", reason: REPLAY_REASON.failed };
    return replayView(query.data, bar, effectiveNow);
  }, [enabled, bar, query.isPending, query.isError, query.data, effectiveNow]);
}
