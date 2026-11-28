import { startTransition, useEffect, useMemo, useState } from "react";
import { useBookReplayAvailable } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { barInterval, type BarInterval } from "../../chart/crosshairSync";
import type { WindowId } from "../../layout/kinds";
import { type PointedReplay, useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref } from "../../stores/ui";
import { kstMidnightUnix } from "../replay-page/replayModel";
import { useTickReplayMatch, useTickReplayPrice } from "../tick-replay/scope";
import { secondOfDay } from "../trades/tape";
import { kstDateOf } from "./replay";

export type WorkspaceReplayCursor =
  | { readonly kind: "live" }
  | { readonly kind: "in_progress"; readonly bar: BarInterval; readonly date: string }
  | {
      readonly kind: "pointed";
      readonly symbol: SymbolCode;
      readonly bar: BarInterval;
      readonly date: string;
      readonly at: UnixSeconds;
      readonly secondOfDay: number;
      readonly minute: number;
      readonly isToday: boolean;
      readonly close: number | null;
    };

const LIVE_CURSOR: WorkspaceReplayCursor = { kind: "live" };

export function useBookReplayEnabled(code?: SymbolCode, windowId?: WindowId): boolean {
  const pref = useBookReplayPref();
  const available = useBookReplayAvailable(pref);
  const tickMatch = useTickReplayMatch(windowId, code);
  return available || tickMatch !== null;
}

export function resolveWorkspaceReplayCursor(
  enabled: boolean,
  code: SymbolCode,
  pointed: PointedReplay | null,
  nowSec: UnixSeconds,
): WorkspaceReplayCursor {
  if (!enabled || pointed === null || pointed.symbol !== code) return LIVE_CURSOR;
  const at = pointed.bar.end - 1;
  const date = kstDateOf(at);
  if (nowSec < pointed.bar.end) {
    return { kind: "in_progress", bar: pointed.bar, date };
  }
  const sec = secondOfDay(at);
  return {
    kind: "pointed",
    symbol: pointed.symbol,
    bar: pointed.bar,
    date,
    at,
    secondOfDay: sec,
    minute: Math.floor(sec / 60),
    isToday: date === kstDateOf(nowSec),
    close: pointed.close,
  };
}

function readPointed(code: SymbolCode, enabled: boolean): PointedReplay | null {
  if (!enabled) return null;
  const pointed = useBookReplayStore.getState().pointed;
  return pointed?.symbol === code ? pointed : null;
}

export function useWorkspaceReplayCursor(code: SymbolCode, windowId?: WindowId): WorkspaceReplayCursor {
  const bookEnabled = useBookReplayEnabled();
  const tickMatch = useTickReplayMatch(windowId, code);
  const tickPrice = useTickReplayPrice(tickMatch?.engine ?? null);
  const [state, setState] = useState<{ readonly code: SymbolCode; readonly pointed: PointedReplay | null }>(() => ({
    code,
    pointed: readPointed(code, bookEnabled),
  }));

  useEffect(() => {
    const next = readPointed(code, bookEnabled);
    setState((prev) => (prev.code === code && prev.pointed === next ? prev : { code, pointed: next }));
    if (!bookEnabled) return;
    return useBookReplayStore.subscribe((storeState) => {
      const nextPointed = storeState.pointed?.symbol === code ? storeState.pointed : null;
      startTransition(() => {
        setState((prev) => (prev.code === code && prev.pointed === nextPointed ? prev : { code, pointed: nextPointed }));
      });
    });
  }, [code, bookEnabled]);

  const pointed = bookEnabled && tickMatch === null && state.code === code ? state.pointed : null;
  const needsClock = pointed !== null || tickMatch !== null;
  const serverTimeOrigin = useServerClock((s) => (needsClock ? s.serverTimeOrigin : null));
  const nowSec = Math.floor(serverNow(serverTimeOrigin) / 1000);
  const inProgress = pointed !== null && nowSec < pointed.bar.end;
  const todayDate = needsClock ? kstDateOf(nowSec) : "";

  const tickDayStart = tickMatch === null ? 0 : (tickMatch.session?.dayStartUnix ?? kstMidnightUnix(tickMatch.target.date));
  const tickDate = tickMatch?.target.date ?? "";
  const tickSec = tickMatch?.control.activeSecond ?? 0;

  return useMemo(() => {
    if (tickMatch !== null) {
      const minute = Math.floor(tickSec / 60);
      const at = tickDayStart + tickSec;
      return {
        kind: "pointed",
        symbol: code,
        bar: barInterval(tickDayStart + minute * 60, "1m"),
        date: tickDate,
        at,
        secondOfDay: tickSec,
        minute,
        isToday: tickDate === todayDate,
        close: tickPrice,
      };
    }
    return resolveWorkspaceReplayCursor(bookEnabled, code, pointed, nowSec);
  }, [tickMatch !== null, tickDayStart, tickDate, tickSec, tickPrice, bookEnabled, code, pointed, inProgress, todayDate]);
}
