import { startTransition, useEffect, useMemo, useState } from "react";
import { useBookReplayAvailable } from "../../api/bookReplay";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { BarInterval } from "../../chart/crosshairSync";
import { type PointedReplay, useBookReplayStore } from "../../stores/bookReplay";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useBookReplayPref } from "../../stores/ui";
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

export function useBookReplayEnabled(): boolean {
  const pref = useBookReplayPref();
  return useBookReplayAvailable(pref);
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

export function useWorkspaceReplayCursor(code: SymbolCode): WorkspaceReplayCursor {
  const enabled = useBookReplayEnabled();
  const [state, setState] = useState<{ readonly code: SymbolCode; readonly pointed: PointedReplay | null }>(() => ({
    code,
    pointed: readPointed(code, enabled),
  }));

  useEffect(() => {
    const next = readPointed(code, enabled);
    setState((prev) => (prev.code === code && prev.pointed === next ? prev : { code, pointed: next }));
    if (!enabled) return;
    return useBookReplayStore.subscribe((storeState) => {
      const nextPointed = storeState.pointed?.symbol === code ? storeState.pointed : null;
      startTransition(() => {
        setState((prev) => (prev.code === code && prev.pointed === nextPointed ? prev : { code, pointed: nextPointed }));
      });
    });
  }, [code, enabled]);

  const pointed = enabled && state.code === code ? state.pointed : null;
  const serverTimeOrigin = useServerClock((s) => (pointed === null ? null : s.serverTimeOrigin));
  const nowSec = Math.floor(serverNow(serverTimeOrigin) / 1000);
  const inProgress = pointed !== null && nowSec < pointed.bar.end;
  const todayDate = pointed === null ? "" : kstDateOf(nowSec);

  return useMemo(
    () => resolveWorkspaceReplayCursor(enabled, code, pointed, nowSec),
    [enabled, code, pointed, inProgress, todayDate],
  );
}
