import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { bookReplayTradesQueryKey, TODAY_REFETCH_MS, useBookReplayTrades } from "../../api/bookReplay";
import type { BookReplayTrades } from "../../api/generated/BookReplayTrades";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { projectTradesReplay, type TradesReplayView } from "./tradesReplay";
import type { WorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

export { projectTradesReplay, type TradesReplayView };

const TRADES_DEBOUNCE_MS = 80;

interface SettledTarget {
  readonly code: SymbolCode;
  readonly date: string;
  readonly untilSec: number;
}

export function useTradesReplay(
  code: SymbolCode,
  cursor: WorkspaceReplayCursor,
  venue: Venue,
  minWon: number,
): TradesReplayView {
  const queryClient = useQueryClient();
  const pointed = cursor.kind === "pointed" ? cursor : null;
  const [settled, setSettled] = useState<SettledTarget | null>(() =>
    pointed === null ? null : { code, date: pointed.date, untilSec: pointed.secondOfDay },
  );

  useEffect(() => {
    if (pointed === null) {
      setSettled(null);
      return;
    }
    const nextTarget: SettledTarget = { code, date: pointed.date, untilSec: pointed.secondOfDay };
    const cached = queryClient.getQueryData<BookReplayTrades>(
      bookReplayTradesQueryKey(code, pointed.date, pointed.secondOfDay, venue, minWon),
    );
    if (cached !== undefined) {
      setSettled(nextTarget);
      return;
    }
    if (settled === null || settled.code !== code || settled.date !== pointed.date) {
      setSettled(nextTarget);
      return;
    }
    if (settled.untilSec === pointed.secondOfDay) return;
    const timer = window.setTimeout(() => setSettled(nextTarget), TRADES_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [code, pointed?.date, pointed?.secondOfDay, venue, minWon, queryClient]);

  const activeTarget = pointed !== null && settled !== null && settled.code === code && settled.date === pointed.date ? settled : null;
  const query = useBookReplayTrades(
    code,
    activeTarget?.date ?? null,
    activeTarget?.untilSec ?? null,
    venue,
    minWon,
    { enabled: activeTarget !== null, isToday: pointed?.isToday },
  );

  const retryDelay = (() => {
    if (pointed === null || !pointed.isToday || activeTarget === null || query.isFetching) return null;
    if (query.isError) return Math.max(0, TODAY_REFETCH_MS - Math.max(0, Date.now() - query.errorUpdatedAt));
    if (query.data === undefined) return null;
    const uncollected =
      query.data.coverage !== "collected" ||
      (query.data.trades.length === 0 && query.data.cumVolume === 0);
    if (!uncollected) return null;
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

  return useMemo(
    () =>
      projectTradesReplay(cursor, {
        data: query.data,
        isPending: query.isPending,
        isError: query.isError,
      }),
    [cursor, query.data, query.isPending, query.isError],
  );
}
