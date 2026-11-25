import { useEffect, useMemo, useState } from "react";
import type { FeedExpected } from "../api/generated/FeedExpected";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import type { ViDirection } from "../api/generated/ViDirection";
import type { ViPlaybook } from "../api/generated/ViPlaybook";
import type { ViState } from "../api/generated/ViState";
import { useViPlaybook } from "../api/viPlaybook";

export const VI_DURATION_SEC = 120;
export const VI_LATE_WINDOW_ELAPSED_SEC = 105;
export const VI_TRAP_PRICE_PCT = 0.5;
export const VI_TRAP_VOLUME_SHRINK_PCT = 30;
const MAX_EXPECTED_POINTS = 240;
const TICK_INTERVAL_MS = 1000;

export interface ViExpectedPoint {
  readonly t: UnixSeconds;
  readonly price: number;
  readonly qty: number;
}

export type ViTrapReason = "price_drop" | "volume_shrink";

export interface ViTrapAlert {
  readonly reason: ViTrapReason;
  readonly changePct: number;
  readonly detectedAt: UnixSeconds;
}

export type ViViewState =
  | { readonly kind: "inactive" }
  | {
      readonly kind: "active";
      readonly trigger: ViState;
      readonly elapsedSec: number;
      readonly remainingSec: number;
      readonly expectedSeries: readonly ViExpectedPoint[];
      readonly trapAlert: ViTrapAlert | null;
      readonly playbook: ViPlaybook | null;
    };

export interface ViTiming {
  readonly elapsedSec: number;
  readonly remainingSec: number;
}

export function computeViTiming(trigger: ViState, nowSec: UnixSeconds): ViTiming {
  const elapsedSec = trigger.triggeredAt === null ? 0 : Math.max(0, Math.floor(nowSec - trigger.triggeredAt));
  const remainingSec = Math.max(0, VI_DURATION_SEC - elapsedSec);
  return { elapsedSec, remainingSec };
}

export function appendExpectedPoint(
  series: readonly ViExpectedPoint[],
  expected: FeedExpected | null,
  t: UnixSeconds,
): readonly ViExpectedPoint[] {
  if (expected === null || !(expected.price > 0) || !Number.isFinite(expected.price)) return series;
  const qty = Number.isFinite(expected.qty) && expected.qty >= 0 ? expected.qty : 0;
  const last = series[series.length - 1];
  if (last !== undefined && last.price === expected.price && last.qty === qty) return series;
  const next = [...series, { t, price: expected.price, qty }];
  return next.length > MAX_EXPECTED_POINTS ? next.slice(next.length - MAX_EXPECTED_POINTS) : next;
}

export function detectTrapAlert(
  series: readonly ViExpectedPoint[],
  direction: ViDirection | null,
  elapsedSec: number,
): ViTrapAlert | null {
  if (elapsedSec < VI_LATE_WINDOW_ELAPSED_SEC || series.length < 2) return null;
  const latest = series[series.length - 1]!;
  let extremePrice = series[0]!.price;
  let peakQty = series[0]!.qty;
  for (let i = 1; i < series.length - 1; i++) {
    const point = series[i]!;
    extremePrice = direction === "down" ? Math.min(extremePrice, point.price) : Math.max(extremePrice, point.price);
    peakQty = Math.max(peakQty, point.qty);
  }
  if (extremePrice > 0) {
    const priceChangePct = ((latest.price - extremePrice) / extremePrice) * 100;
    if (direction === "down" && priceChangePct >= VI_TRAP_PRICE_PCT) {
      return { reason: "price_drop", changePct: priceChangePct, detectedAt: latest.t };
    }
    if (direction !== "down" && priceChangePct <= -VI_TRAP_PRICE_PCT) {
      return { reason: "price_drop", changePct: priceChangePct, detectedAt: latest.t };
    }
  }
  if (peakQty > 0) {
    const volumeChangePct = ((latest.qty - peakQty) / peakQty) * 100;
    if (volumeChangePct <= -VI_TRAP_VOLUME_SHRINK_PCT) {
      return { reason: "volume_shrink", changePct: volumeChangePct, detectedAt: latest.t };
    }
  }
  return null;
}

export interface ViViewInput {
  readonly vi: ViState | null;
  readonly nowSec: UnixSeconds;
  readonly expectedSeries: readonly ViExpectedPoint[];
  readonly playbook: ViPlaybook | null;
}

export function resolveViViewState({ vi, nowSec, expectedSeries, playbook }: ViViewInput): ViViewState {
  if (vi === null || !vi.active) return { kind: "inactive" };
  const { elapsedSec, remainingSec } = computeViTiming(vi, nowSec);
  const trapAlert = detectTrapAlert(expectedSeries, vi.direction, elapsedSec);
  return {
    kind: "active",
    trigger: vi,
    elapsedSec,
    remainingSec,
    expectedSeries,
    trapAlert,
    playbook,
  };
}

export function formatCountdown(remainingSec: number): string {
  const clamped = Math.max(0, Math.floor(remainingSec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface TrackedSeries {
  readonly key: string | null;
  readonly points: readonly ViExpectedPoint[];
}

export function useViSession(
  code: SymbolCode,
  vi: ViState | null,
  expected: FeedExpected | null,
  enabled: boolean,
): ViViewState {
  const active = enabled && vi !== null && vi.active;
  const sessionKey = active ? `${code}:${vi.market}:${vi.triggeredAt ?? "live"}` : null;
  const direction: ViDirection = vi?.direction ?? "up";
  const playbookQuery = useViPlaybook(code, direction, "all", active);

  const [nowSec, setNowSec] = useState<UnixSeconds>(() => Math.floor(Date.now() / 1000));
  const [tracked, setTracked] = useState<TrackedSeries>({ key: null, points: [] });

  useEffect(() => {
    if (!active) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, sessionKey]);

  useEffect(() => {
    if (sessionKey === null) {
      setTracked((prev) => (prev.key === null && prev.points.length === 0 ? prev : { key: null, points: [] }));
      return;
    }
    const stamp = Math.floor(Date.now() / 1000);
    setNowSec(stamp);
    setTracked((prev) => {
      const base = prev.key === sessionKey ? prev.points : [];
      const next = appendExpectedPoint(base, expected, stamp);
      if (prev.key === sessionKey && next === prev.points) return prev;
      return { key: sessionKey, points: next };
    });
  }, [sessionKey, expected?.price, expected?.qty]);

  return useMemo(() => {
    if (!active) return { kind: "inactive" };
    const points = tracked.key === sessionKey ? tracked.points : [];
    return resolveViViewState({
      vi,
      nowSec,
      expectedSeries: points,
      playbook: playbookQuery.data ?? null,
    });
  }, [active, vi, nowSec, tracked, sessionKey, playbookQuery.data]);
}
