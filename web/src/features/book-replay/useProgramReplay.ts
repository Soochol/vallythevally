import { useEffect, useMemo } from "react";
import { TODAY_REFETCH_MS, useBookReplayProgramDay } from "../../api/bookReplay";
import type { ReplayVenueScope } from "../../api/generated/ReplayVenueScope";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { WindowId } from "../../layout/kinds";
import { gapContaining } from "../brokers/history";
import type { ProgramLine, ProgramRow } from "../program/program";
import { projectTickReplayProgram } from "../tick-replay/projections";
import { useTickReplayFrame, useTickReplayMatch } from "../tick-replay/scope";
import { sliceProgramReplayAt } from "./programReplay";
import { REPLAY_REASON } from "./replay";
import type { WorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

export type ProgramReplayView =
  | { readonly kind: "live" }
  | { readonly kind: "none"; readonly reason: string }
  | {
      readonly kind: "past";
      readonly at: UnixSeconds;
      readonly previousClose: number | null;
      readonly venueScope?: ReplayVenueScope;
      readonly latest: ProgramRow | undefined;
      readonly lines: readonly ProgramLine[];
      readonly trend: readonly number[];
      readonly rowCount: number;
    };

const LIVE_PROGRAM_VIEW: ProgramReplayView = { kind: "live" };

export function useProgramReplay(code: SymbolCode, cursor: WorkspaceReplayCursor, windowId?: WindowId): ProgramReplayView {
  const tickMatch = useTickReplayMatch(windowId, code);
  const tickFrame = useTickReplayFrame(tickMatch?.engine ?? null);
  const pointed = tickMatch === null && cursor.kind === "pointed" ? cursor : null;
  const query = useBookReplayProgramDay(code, pointed?.date ?? null, {
    enabled: pointed !== null,
    isToday: pointed?.isToday,
  });

  const retryDelay = (() => {
    if (pointed === null || !pointed.isToday || query.isFetching) return null;
    if (query.isError) return Math.max(0, TODAY_REFETCH_MS - Math.max(0, Date.now() - query.errorUpdatedAt));
    if (query.data === undefined) return null;
    const lastRowSec = query.data.rows.length > 0 ? query.data.rows[query.data.rows.length - 1]!.secondOfDay : -1;
    const needsRefresh =
      query.data.coverage !== "collected" ||
      lastRowSec < pointed.secondOfDay ||
      gapContaining(query.data.gaps, pointed.at) !== null;
    if (!needsRefresh) return null;
    return Math.max(0, TODAY_REFETCH_MS - Math.max(0, Date.now() - query.dataUpdatedAt));
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

  return useMemo<ProgramReplayView>(() => {
    if (tickMatch !== null) return projectTickReplayProgram(tickMatch, tickFrame);
    if (cursor.kind === "live") return LIVE_PROGRAM_VIEW;
    if (cursor.kind === "in_progress") return { kind: "none", reason: REPLAY_REASON.inProgress };

    const { data } = query;
    if (data === undefined) {
      if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
      return { kind: "none", reason: REPLAY_REASON.failed };
    }
    if (data.coverage === "day_not_collected") return { kind: "none", reason: REPLAY_REASON.dayNotCollected };
    if (data.coverage === "symbol_not_collected") return { kind: "none", reason: REPLAY_REASON.symbolNotCollected };
    if (gapContaining(data.gaps, cursor.at) !== null) return { kind: "none", reason: REPLAY_REASON.gap };

    const slice = sliceProgramReplayAt(data.rows, data.gaps, cursor.date, cursor.at);
    return {
      kind: "past",
      at: cursor.at,
      previousClose: data.previousClose ?? null,
      venueScope: data.venueScope,
      ...slice,
    };
  }, [tickMatch, tickFrame, cursor, query.data, query.isPending, query.isError]);
}
