import type { QueryClient } from "@tanstack/react-query";
import type { KstDate } from "../../api/generated/KstDate";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingExecutions } from "../../api/generated/TradingExecutions";
import type { TradingFillNotice } from "../../api/generated/TradingFillNotice";
import { useUiStore } from "../../stores/ui";

export type OrderSoundKind = "buy-accepted" | "sell-accepted" | "filled";

export interface ToneStep {
  readonly frequency: number;
  readonly delaySec: number;
  readonly durationSec: number;
  readonly gain: number;
  readonly type: OscillatorType;
}

export const ORDER_SOUND_TONES: Readonly<Record<OrderSoundKind, readonly ToneStep[]>> = {
  "buy-accepted": [
    { frequency: 880, delaySec: 0, durationSec: 0.08, gain: 0.14, type: "triangle" },
    { frequency: 1174.66, delaySec: 0.075, durationSec: 0.11, gain: 0.16, type: "triangle" },
  ],
  "sell-accepted": [
    { frequency: 659.25, delaySec: 0, durationSec: 0.08, gain: 0.14, type: "triangle" },
    { frequency: 493.88, delaySec: 0.075, durationSec: 0.11, gain: 0.16, type: "triangle" },
  ],
  filled: [
    { frequency: 783.99, delaySec: 0, durationSec: 0.075, gain: 0.14, type: "sine" },
    { frequency: 1046.5, delaySec: 0.07, durationSec: 0.075, gain: 0.15, type: "sine" },
    { frequency: 1567.98, delaySec: 0.14, durationSec: 0.14, gain: 0.17, type: "sine" },
  ],
};

const ATTACK_SEC = 0.005;
const MIN_GAIN = 0.0001;
const GAP_SEC = 0.025;
const MAX_QUEUE_SEC = 0.25;

export interface ExecutionTracker {
  observe(data: TradingExecutions): boolean;
  observeFill(accountRef: string, fill: TradingFillNotice): boolean;
}

export function executionTotalsOf(executions: readonly TradingExecution[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const execution of executions) {
    totals.set(execution.orderNo, (totals.get(execution.orderNo) ?? 0) + execution.quantity);
  }
  return totals;
}

interface AccountSnapshot {
  day: KstDate | null;
  totals: Map<string, number>;
  unkeyedFills: number;
}

const positiveQuantity = (value: number | null): number => (value !== null && Number.isFinite(value) && value > 0 ? value : 0);

export function createExecutionTracker(): ExecutionTracker {
  const snapshots = new Map<string, AccountSnapshot>();
  return {
    observe(data: TradingExecutions): boolean {
      const nextTotals = executionTotalsOf(data.executions);
      const prev = snapshots.get(data.accountRef);
      if (prev === undefined || (prev.day !== null && prev.day !== data.day)) {
        snapshots.set(data.accountRef, { day: data.day, totals: new Map(nextTotals), unkeyedFills: 0 });
        return false;
      }
      if (prev.day === null) {
        const merged = new Map(nextTotals);
        for (const [orderNo, quantity] of prev.totals) {
          merged.set(orderNo, Math.max(merged.get(orderNo) ?? 0, quantity));
        }
        snapshots.set(data.accountRef, { day: data.day, totals: merged, unkeyedFills: 0 });
        return false;
      }
      let increased = false;
      const merged = new Map(prev.totals);
      for (const [orderNo, quantity] of nextTotals) {
        if (quantity > (prev.totals.get(orderNo) ?? 0)) {
          increased = true;
          merged.set(orderNo, quantity);
        }
      }
      const unkeyedFills = increased && prev.unkeyedFills > 0 ? 0 : prev.unkeyedFills;
      snapshots.set(data.accountRef, { day: data.day, totals: merged, unkeyedFills });
      return increased && prev.unkeyedFills === 0;
    },
    observeFill(accountRef: string, fill: TradingFillNotice): boolean {
      let current = snapshots.get(accountRef);
      if (current === undefined) {
        current = { day: null, totals: new Map(), unkeyedFills: 0 };
        snapshots.set(accountRef, current);
      }
      const orderNo = fill.orderNo?.trim() ?? "";
      const delta = positiveQuantity(fill.quantity);
      const cumulative = positiveQuantity(fill.cumulativeQuantity);
      if (orderNo === "" || (delta === 0 && cumulative === 0)) {
        current.unkeyedFills += 1;
        return true;
      }
      const before = current.totals.get(orderNo) ?? 0;
      const next = cumulative > 0 ? cumulative : before + delta;
      if (next <= before) return false;
      current.totals.set(orderNo, next);
      return true;
    },
  };
}

export interface OrderSoundPlayer {
  prime(): void;
  play(kind: OrderSoundKind): void;
  isRunning(): boolean;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function defaultAudioContext(): AudioContext | null {
  const host = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor = host.AudioContext ?? host.webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor({ latencyHint: "interactive" });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

export function createOrderSoundPlayer(createContext: () => AudioContext | null = defaultAudioContext): OrderSoundPlayer {
  let context: AudioContext | null = null;
  let nextStart = 0;

  const obtain = (): AudioContext | null => {
    if (context !== null && context.state !== "closed") return context;
    try {
      context = createContext();
      nextStart = 0;
    } catch {
      context = null;
    }
    return context;
  };

  return {
    isRunning(): boolean {
      return context !== null && context.state === "running";
    },
    prime(): void {
      try {
        const ctx = obtain();
        if (ctx !== null && ctx.state === "suspended") void Promise.resolve(ctx.resume()).catch(() => {});
      } catch {
        return;
      }
    },
    play(kind: OrderSoundKind): void {
      try {
        const ctx = obtain();
        if (ctx === null) return;
        if (ctx.state === "suspended") void Promise.resolve(ctx.resume()).catch(() => {});
        const now = ctx.currentTime;
        const base = Math.max(now, Math.min(nextStart, now + MAX_QUEUE_SEC));
        let lastEnd = base;
        for (const step of ORDER_SOUND_TONES[kind]) {
          const start = base + step.delaySec;
          const end = start + step.durationSec;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = step.type;
          osc.frequency.setValueAtTime(step.frequency, start);
          gain.gain.setValueAtTime(MIN_GAIN, start);
          gain.gain.linearRampToValueAtTime(step.gain, start + Math.min(ATTACK_SEC, step.durationSec / 2));
          gain.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
          };
          osc.start(start);
          osc.stop(end);
          if (end > lastEnd) lastEnd = end;
        }
        nextStart = lastEnd + GAP_SEC;
      } catch {
        return;
      }
    },
  };
}

const orderSoundPlayer = createOrderSoundPlayer();
const trackers = new WeakMap<QueryClient, ExecutionTracker>();

const isSoundEnabled = (): boolean => useUiStore.getState().prefs.orderSettings.sound;

function trackerOf(client: QueryClient): ExecutionTracker {
  let tracker = trackers.get(client);
  if (tracker === undefined) {
    tracker = createExecutionTracker();
    trackers.set(client, tracker);
  }
  return tracker;
}

export function primeOrderSound(): void {
  if (isSoundEnabled()) orderSoundPlayer.prime();
}

export function installOrderSoundPrimer(target: EventTarget | undefined = typeof window === "undefined" ? undefined : window): () => void {
  if (target === undefined) return () => {};
  const onGesture = () => {
    if (isSoundEnabled() && !orderSoundPlayer.isRunning()) orderSoundPlayer.prime();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  target.addEventListener("pointerdown", onGesture, options);
  target.addEventListener("keydown", onGesture, options);
  return () => {
    target.removeEventListener("pointerdown", onGesture, options);
    target.removeEventListener("keydown", onGesture, options);
  };
}

export function playOrderSound(kind: OrderSoundKind): void {
  if (isSoundEnabled()) orderSoundPlayer.play(kind);
}

export function observeOrderExecutions(client: QueryClient, data: TradingExecutions): void {
  if (trackerOf(client).observe(data)) playOrderSound("filled");
}

export function observeOrderFill(client: QueryClient, accountRef: string, fill: TradingFillNotice): void {
  if (trackerOf(client).observeFill(accountRef, fill)) playOrderSound("filled");
}
