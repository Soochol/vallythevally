import type { BrokerDay } from "../../api/brokers";
import type { BookReplayCoverage } from "../../api/generated/BookReplayCoverage";
import type { BrokerDaySource } from "../../api/generated/BrokerDaySource";
import type { ReplayVenueScope } from "../../api/generated/ReplayVenueScope";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { FeedEvent } from "../../api/socket";
import { appendSnapshots, type BrokerEvent, type BrokerState, compactBrokerState, EMPTY_BROKER_STATE, reduceBrokerEvents } from "./model";

export const TODAY_POLL_MS = 2_000;
export const FALLBACK_RECHECK_MS = 30_000;

export type BrokerDayMode = "loading" | "collected" | "fallback" | "live";

export interface BrokerDaySnapshot {
  readonly mode: BrokerDayMode;
  readonly date: string | null;
  readonly source: BrokerDaySource | null;
  readonly coverage?: BookReplayCoverage;
  readonly venueScope?: ReplayVenueScope;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  readonly failed: boolean;
}

export interface TodayBrokerFeedDeps {
  fetchDay(code: SymbolCode, date: string, after?: string, signal?: AbortSignal, fallback?: "latest"): Promise<BrokerDay>;
  subscribeLive(code: SymbolCode, listener: (event: FeedEvent) => void): () => void;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  requestFrame(fn: () => void): number;
  cancelFrame(id: number): void;
  isDocumentVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
}

export interface TodayBrokerFeedConfig {
  readonly date: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly allowFallback?: boolean;
  readonly allowLiveFallback?: boolean;
}

export interface TodayBrokerFeed {
  snapshot(): BrokerDaySnapshot;
  subscribe(listener: () => void): () => void;
  configure(config: TodayBrokerFeedConfig): void;
  retry(): void;
  dispose(): void;
}

export const EMPTY_BROKER_GAPS: readonly (readonly [UnixSeconds, UnixSeconds])[] = [];

export const LOADING_BROKER_SNAPSHOT: BrokerDaySnapshot = {
  mode: "loading",
  date: null,
  source: null,
  state: EMPTY_BROKER_STATE,
  gaps: EMPTY_BROKER_GAPS,
  failed: false,
};

export const FAILED_COLLECTED_SNAPSHOT: BrokerDaySnapshot = {
  mode: "collected",
  date: null,
  source: null,
  state: EMPTY_BROKER_STATE,
  gaps: EMPTY_BROKER_GAPS,
  failed: true,
};

function sameGaps(
  a: readonly (readonly [UnixSeconds, UnixSeconds])[],
  b: readonly (readonly [UnixSeconds, UnixSeconds])[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

function applyCollected(previous: BrokerDaySnapshot, reply: BrokerDay): BrokerDaySnapshot {
  const base = reply.reset || previous.mode !== "collected" ? EMPTY_BROKER_STATE : previous.state;
  const nextState = compactBrokerState(appendSnapshots(base, reply.snapshots, reply.gaps));
  const nextGaps = sameGaps(previous.gaps, reply.gaps) ? previous.gaps : reply.gaps;
  if (
    previous.mode === "collected" &&
    previous.date === reply.date &&
    previous.source === reply.source &&
    previous.coverage === reply.coverage &&
    previous.venueScope === reply.venueScope &&
    !previous.failed &&
    nextState === previous.state &&
    nextGaps === previous.gaps
  ) {
    return previous;
  }
  return { mode: "collected", date: reply.date, source: reply.source, coverage: reply.coverage, venueScope: reply.venueScope, state: nextState, gaps: nextGaps, failed: false };
}

function toFallbackSnapshot(reply: BrokerDay): BrokerDaySnapshot {
  return {
    mode: "fallback",
    date: reply.date,
    source: reply.source,
    venueScope: reply.venueScope,
    state: compactBrokerState(appendSnapshots(EMPTY_BROKER_STATE, reply.snapshots, reply.gaps)),
    gaps: reply.gaps,
    failed: false,
  };
}

export function createTodayBrokerFeed(code: SymbolCode, deps: TodayBrokerFeedDeps): TodayBrokerFeed {
  const listeners = new Set<() => void>();
  let current: BrokerDaySnapshot = LOADING_BROKER_SNAPSHOT;
  let liveState: BrokerState = EMPTY_BROKER_STATE;
  let liveDate: string | null = null;
  let hadLiveSubscription = false;

  let active = false;
  let enabled = false;
  let allowFallback = false;
  let allowLiveFallback = true;
  let date = "";
  let disposed = false;

  let sessionId = 0;
  let controller: AbortController | null = null;
  let timer: number | null = null;
  let cursor = "";
  let polling = false;
  let recheckingFallback = false;
  let inFlight = false;
  let paused = false;

  let unsubscribeLive: (() => void) | null = null;
  let frameId: number | null = null;
  let pendingLive: BrokerEvent[] = [];

  const emit = (next: BrokerDaySnapshot) => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };

  const clearPollTimer = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const stopLive = () => {
    if (unsubscribeLive !== null) {
      unsubscribeLive();
      unsubscribeLive = null;
    }
    if (frameId !== null) {
      deps.cancelFrame(frameId);
      frameId = null;
    }
    pendingLive = [];
  };

  const stopSession = () => {
    sessionId += 1;
    clearPollTimer();
    controller?.abort();
    controller = null;
    polling = false;
    recheckingFallback = false;
    inFlight = false;
    paused = false;
    cursor = "";
    stopLive();
  };

  const isVisible = () => active && deps.isDocumentVisible();

  const enqueueLive = (event: BrokerEvent) => {
    pendingLive.push(event);
    if (frameId !== null) return;
    const expectedSession = sessionId;
    frameId = deps.requestFrame(() => {
      frameId = null;
      if (disposed || sessionId !== expectedSession) return;
      const batch = pendingLive;
      if (batch.length === 0) return;
      pendingLive = [];
      liveState = reduceBrokerEvents(liveState, batch);
      emit({ mode: "live", date: null, source: "none", state: liveState, gaps: EMPTY_BROKER_GAPS, failed: current.failed });
    });
  };

  const startLive = (expectedSession: number, preserveFallback: boolean) => {
    stopLive();
    if (!preserveFallback) {
      emit({ mode: "live", date: null, source: "none", state: liveState, gaps: EMPTY_BROKER_GAPS, failed: false });
      if (hadLiveSubscription) enqueueLive({ type: "resync" });
      hadLiveSubscription = true;
    }
    unsubscribeLive = deps.subscribeLive(code, (event) => {
      if (disposed || sessionId !== expectedSession) return;
      if (event.type === "feed_brokers") {
        if (recheckingFallback) {
          recheckingFallback = false;
          clearPollTimer();
          controller?.abort();
          controller = null;
          inFlight = false;
        }
        hadLiveSubscription = true;
        enqueueLive({ type: "snapshot", brokers: event.brokers });
      } else if (current.mode === "fallback") {
        return;
      } else if (event.type === "feed_link") {
        enqueueLive({ type: "link", live: event.live });
      } else if (event.type === "resync") {
        enqueueLive({ type: "resync" });
      } else if (event.type === "feed_subscribed") {
        if (current.mode === "live" && current.failed) {
          emit({ ...current, failed: false });
        }
      } else if (event.type === "sub_error") {
        if (current.mode === "live" && !current.failed) {
          emit({ ...current, failed: true });
        }
      }
    });
  };

  const scheduleNext = (expectedSession: number) => {
    if (disposed || sessionId !== expectedSession || !polling) return;
    if (!isVisible()) {
      paused = true;
      return;
    }
    clearPollTimer();
    timer = deps.setTimer(() => {
      timer = null;
      void runRequest(false, expectedSession);
    }, TODAY_POLL_MS);
  };

  const scheduleFallbackRecheck = (expectedSession: number) => {
    if (disposed || sessionId !== expectedSession || !recheckingFallback) return;
    if (!isVisible()) {
      paused = true;
      return;
    }
    clearPollTimer();
    timer = deps.setTimer(() => {
      timer = null;
      void runFallbackRecheck(expectedSession);
    }, FALLBACK_RECHECK_MS);
  };

  const runFallbackRecheck = async (expectedSession: number) => {
    if (disposed || sessionId !== expectedSession || !recheckingFallback || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const reply = await deps.fetchDay(code, date, undefined, signal);
      if (disposed || sessionId !== expectedSession || signal.aborted) return;
      inFlight = false;
      if (!recheckingFallback) return;
      if (reply.source !== "none" && reply.date === date && reply.snapshots.length > 0) {
        stopLive();
        recheckingFallback = false;
        cursor = reply.cursor;
        if (reply.source === "store") {
          polling = false;
          emit(applyCollected(current, reply));
          return;
        }
        polling = true;
        emit(applyCollected(current, reply));
        scheduleNext(expectedSession);
        return;
      }
      scheduleFallbackRecheck(expectedSession);
    } catch {
      if (disposed || sessionId !== expectedSession || signal.aborted) return;
      inFlight = false;
      if (recheckingFallback) scheduleFallbackRecheck(expectedSession);
    }
  };

  const runRequest = async (initial: boolean, expectedSession: number) => {
    if (disposed || sessionId !== expectedSession || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const { signal } = controller;
    const fallback = initial && allowFallback && liveState.grid.times.length === 0 ? "latest" : undefined;
    try {
      const reply = await deps.fetchDay(code, date, initial ? undefined : cursor, signal, fallback);
      if (disposed || sessionId !== expectedSession || signal.aborted) return;
      inFlight = false;
      if (reply.source === "none") {
        polling = false;
        if (!allowLiveFallback) {
          stopLive();
          emit({ mode: "collected", date, source: "none", coverage: reply.coverage, state: EMPTY_BROKER_STATE, gaps: EMPTY_BROKER_GAPS, failed: false });
          return;
        }
        startLive(expectedSession, false);
        return;
      }
      if (initial && reply.source === "store" && reply.date !== date) {
        polling = false;
        recheckingFallback = true;
        emit(toFallbackSnapshot(reply));
        startLive(expectedSession, true);
        scheduleFallbackRecheck(expectedSession);
        return;
      }
      cursor = reply.cursor;
      if (reply.source === "store") {
        polling = false;
        emit(applyCollected(current, reply));
        return;
      }
      polling = true;
      emit(applyCollected(current, reply));
      scheduleNext(expectedSession);
    } catch {
      if (disposed || sessionId !== expectedSession || signal.aborted) return;
      inFlight = false;
      if (initial) {
        polling = false;
        if (!allowLiveFallback) {
          stopLive();
          emit({ mode: "collected", date, source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_BROKER_GAPS, failed: true });
          return;
        }
        startLive(expectedSession, false);
        return;
      }
      if (polling) scheduleNext(expectedSession);
    }
  };

  const startSession = () => {
    stopSession();
    emit(LOADING_BROKER_SNAPSHOT);
    const currentSession = sessionId;
    void runRequest(true, currentSession);
  };

  const syncVisibility = () => {
    if (disposed || (!polling && !recheckingFallback)) return;
    const currentSession = sessionId;
    if (isVisible()) {
      if (paused && !inFlight) {
        paused = false;
        clearPollTimer();
        if (recheckingFallback) void runFallbackRecheck(currentSession);
        else void runRequest(false, currentSession);
      }
    } else {
      paused = true;
      clearPollTimer();
    }
  };

  const removeVisibilityListener = deps.onVisibilityChange(syncVisibility);

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(next) {
      if (disposed) return;
      const nextAllowFallback = next.allowFallback ?? false;
      const nextAllowLiveFallback = next.allowLiveFallback ?? true;
      const dateChanged = next.date !== date;
      const enabledChanged = next.enabled !== enabled;
      const activeChanged = next.active !== active;
      const allowFallbackChanged = nextAllowFallback !== allowFallback;
      const allowLiveFallbackChanged = nextAllowLiveFallback !== allowLiveFallback;
      active = next.active;
      if (next.enabled && next.date !== liveDate) {
        if (liveDate !== null) {
          liveState = EMPTY_BROKER_STATE;
          hadLiveSubscription = false;
        }
        liveDate = next.date;
      }
      date = next.date;
      enabled = next.enabled;
      allowFallback = nextAllowFallback;
      allowLiveFallback = nextAllowLiveFallback;
      if (!enabled) {
        if (enabledChanged || current !== LOADING_BROKER_SNAPSHOT) {
          stopSession();
          emit(LOADING_BROKER_SNAPSHOT);
        }
        return;
      }
      if (enabledChanged || dateChanged || allowFallbackChanged || allowLiveFallbackChanged) {
        startSession();
        return;
      }
      if (activeChanged) syncVisibility();
    },
    retry() {
      if (disposed || !enabled) return;
      if (current.mode === "live") {
        const expectedSession = sessionId;
        startLive(expectedSession, false);
        return;
      }
      startSession();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSession();
      removeVisibilityListener();
      listeners.clear();
    },
  };
}
