import { useCallback, useMemo } from "react";
import { useBookReplayAvailable, useBookReplayDay } from "../../api/bookReplay";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref } from "../../stores/ui";
import { kstDateOf, REPLAY_REASON, replayDate, replayView, type ReplayView } from "./replay";

const LIVE_VIEW: ReplayView = { kind: "live" };

export function useBookReplayEnabled(): boolean {
  const pref = useBookReplayPref();
  const available = useBookReplayAvailable();
  return pref && available;
}

export function useBookReplay(code: SymbolCode): ReplayView {
  const enabled = useBookReplayEnabled();
  const bar = useBookReplayStore((state) => (enabled && state.pointed?.symbol === code ? state.pointed.bar : null));
  const serverTimeOrigin = useServerClock((state) => (bar === null ? null : state.serverTimeOrigin));
  const date = bar === null ? null : replayDate(bar);
  const now = Math.floor(serverNow(serverTimeOrigin) / 1000);
  const isToday = date !== null && date === kstDateOf(now);

  const shouldPoll = useCallback(
    (day: BookReplayDay): boolean => {
      if (!isToday || bar === null) return false;
      if (day.coverage === "day_not_collected" || day.coverage === "symbol_not_collected") return true;
      const currentNow = Math.floor(serverNow(useServerClock.getState().serverTimeOrigin) / 1000);
      const view = replayView(day, bar, currentNow);
      return view.kind === "none" && view.reason === REPLAY_REASON.afterLastCovered;
    },
    [isToday, bar],
  );

  const query = useBookReplayDay(code, date, { enabled: enabled && bar !== null, shouldPoll });

  return useMemo<ReplayView>(() => {
    if (!enabled || bar === null) return LIVE_VIEW;
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    if (query.isError || query.data === undefined) return { kind: "none", reason: REPLAY_REASON.failed };
    return replayView(query.data, bar, now);
  }, [enabled, bar, query.isPending, query.isError, query.data, now]);
}
