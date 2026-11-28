import { useEffect, useMemo } from "react";
import { TODAY_REFETCH_MS, useBookReplayDay, useBookReplayLockAvailable } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref, useUiStore } from "../../stores/ui";
import { projectTickReplayBook } from "../tick-replay/projections";
import { useTickReplayFrame, useTickReplayMatch } from "../tick-replay/scope";
import { REPLAY_REASON, replayView, todayRefreshDelayMs, type ReplayView } from "./replay";
import { useBookReplayEnabled, useWorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

const LIVE_VIEW: ReplayView = { kind: "live" };

export { useBookReplayEnabled };

export function disableBookReplay(): void {
  useUiStore.getState().setBookReplay(false);
  useBookReplayStore.getState().clear();
}

export function useBookReplayOrderLock(code?: SymbolCode, windowId?: WindowId): boolean {
  const pref = useBookReplayPref();
  const bookLock = useBookReplayLockAvailable(pref);
  const tickMatch = useTickReplayMatch(windowId, code);
  return bookLock || tickMatch !== null;
}

export function useBookReplay(code: SymbolCode, windowId?: WindowId): ReplayView {
  const tickMatch = useTickReplayMatch(windowId, code);
  const tickFrame = useTickReplayFrame(tickMatch?.engine ?? null);
  const cursor = useWorkspaceReplayCursor(code, windowId);
  const pointed = tickMatch === null && cursor.kind === "pointed" ? cursor : null;
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
    if (tickMatch !== null) return projectTickReplayBook(tickMatch, tickFrame);
    if (cursor.kind === "live") return LIVE_VIEW;
    if (cursor.kind === "in_progress") return { kind: "none", reason: REPLAY_REASON.inProgress };
    if (query.data !== undefined) return replayView(query.data, cursor.bar, cursor.bar.end);
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    return { kind: "none", reason: REPLAY_REASON.failed };
  }, [tickMatch, tickFrame, cursor, query.isPending, query.data]);
}
