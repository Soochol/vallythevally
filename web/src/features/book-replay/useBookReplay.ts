import { useEffect, useMemo } from "react";
import { TODAY_REFETCH_MS, useBookReplayDay } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { REPLAY_REASON, replayView, todayRefreshDelayMs, type ReplayView } from "./replay";
import { useBookReplayEnabled, useWorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

const LIVE_VIEW: ReplayView = { kind: "live" };

export { useBookReplayEnabled };

export function useBookReplay(code: SymbolCode): ReplayView {
  const cursor = useWorkspaceReplayCursor(code);
  const pointed = cursor.kind === "pointed" ? cursor : null;
  const serverTimeOrigin = useServerClock((state) => (pointed === null ? null : state.serverTimeOrigin));
  const now = Math.floor(serverNow(serverTimeOrigin) / 1000);

  const query = useBookReplayDay(code, pointed?.date ?? null, { enabled: pointed !== null });

  const retryDelay = (() => {
    if (pointed === null || query.isFetching) return null;
    if (query.isError) return Math.max(0, TODAY_REFETCH_MS - Math.max(0, Date.now() - query.errorUpdatedAt));
    if (query.data === undefined) return null;
    return todayRefreshDelayMs(query.data, pointed.bar, now, query.dataUpdatedAt, Date.now(), TODAY_REFETCH_MS);
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
  }, [retryDelay, query.refetch, query.dataUpdatedAt, query.errorUpdatedAt, pointed]);

  return useMemo<ReplayView>(() => {
    if (cursor.kind === "live") return LIVE_VIEW;
    if (cursor.kind === "in_progress") return { kind: "none", reason: REPLAY_REASON.inProgress };
    if (query.data !== undefined) return replayView(query.data, cursor.bar, cursor.bar.end);
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    return { kind: "none", reason: REPLAY_REASON.failed };
  }, [cursor, query.isPending, query.data]);
}
