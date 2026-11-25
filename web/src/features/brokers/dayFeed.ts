import type { BrokerDay } from "../../api/brokers";
import type { BrokerDaySource } from "../../api/generated/BrokerDaySource";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { FeedEvent } from "../../api/socket";
import { appendSnapshots, type BrokerEvent, type BrokerState, EMPTY_BROKER_STATE, reduceBrokerEvents } from "./model";

export const TODAY_POLL_MS = 2_000;

export type BrokerDayMode = "loading" | "collected" | "live";

export interface BrokerDaySnapshot {
  readonly mode: BrokerDayMode;
  readonly date: string | null;
  readonly source: BrokerDaySource | null;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  readonly failed: boolean;
}

export interface TodayBrokerFeedDeps {
  fetchDay(code: SymbolCode, date: string, after?: string, signal?: AbortSignal): Promise<BrokerDay>;
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
  const base = reply.reset ? EMPTY_BROKER_STATE : previous.state;
  const nextState = appendSnapshots(base, reply.snapshots, reply.gaps);
  const nextGaps = sameGaps(previous.gaps, reply.gaps) ? previous.gaps : reply.gaps;
  if (
    previous.mode === "collected" &&
    previous.date === reply.date &&
    previous.source === reply.source &&
    !previous.failed &&
    nextState === previous.state &&
    nextGaps === previous.gaps
  ) {
    return previous;
  }
  return { mode: "collected", date: reply.date, source: reply.source, state: nextState, gaps: nextGaps, failed: false };
}

export function createTodayBrokerFeed(code: SymbolCode, deps: TodayBrokerFeedDeps): TodayBrokerFeed {
  const listeners = new Set<() => void>();
  let current: BrokerDaySnapshot = LOADING_BROKER_SNAPSHOT;
  let liveState: BrokerState = EMPTY_BROKER_STATE;
  let liveDate: string | null = null;
  let hadLiveSubscription = false;

  let active = false;
  let enabled = false;
  let date = "";
  let disposed = false;

  let sessionId = 0;
  let controller: AbortController | null = null;
  let timer: number | null = null;
  let cursor = "";
  let polling = false;
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

  const startLive = (expectedSession: number) => {
    stopLive();
    emit({ mode: "live", date: null, source: "none", state: liveState, gaps: EMPTY_BROKER_GAPS, failed: false });
    if (hadLiveSubscription) enqueueLive({ type: "resync" });
    hadLiveSubscription = true;
    unsubscribeLive = deps.subscribeLive(code, (event) => {
      if (disposed || sessionId !== expectedSession) return;
      if (event.type === "feed_brokers") enqueueLive({ type: "snapshot", brokers: event.brokers });
      else if (event.type === "feed_link") enqueueLive({ type: "link", live: event.live });
      else if (event.type === "resync") enqueueLive({ type: "resync" });
      else if (event.type === "feed_subscribed") {
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

  const runRequest = async (initial: boolean, expectedSession: number) => {
    if (disposed || sessionId !== expectedSession || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const reply = await deps.fetchDay(code, date, initial ? undefined : cursor, signal);
      if (disposed || sessionId !== expectedSession || signal.aborted) return;
      inFlight = false;
      if (reply.source === "none") {
        polling = false;
        startLive(expectedSession);
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
        startLive(expectedSession);
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
    if (disposed || !polling) return;
    const currentSession = sessionId;
    if (isVisible()) {
      if (paused && !inFlight) {
        paused = false;
        clearPollTimer();
        void runRequest(false, currentSession);
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
      const dateChanged = next.date !== date;
      const enabledChanged = next.enabled !== enabled;
      const activeChanged = next.active !== active;
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
      if (!enabled) {
        if (enabledChanged || current !== LOADING_BROKER_SNAPSHOT) {
          stopSession();
          emit(LOADING_BROKER_SNAPSHOT);
        }
        return;
      }
      if (enabledChanged || dateChanged) {
        startSession();
        return;
      }
      if (activeChanged) syncVisibility();
    },
    retry() {
      if (disposed || !enabled) return;
      if (current.mode === "live") {
        const expectedSession = sessionId;
        startLive(expectedSession);
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
