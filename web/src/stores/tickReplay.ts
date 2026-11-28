import { create } from "zustand";
import type { LinkColor } from "../api/generated/LinkColor";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WindowId } from "../layout/kinds";
import { replayPointScheduler } from "../features/book-replay/pointScheduler";
import type { ReplayEngine, ReplayEngineControlState } from "../features/replay-page/replayEngine";
import type { ReplaySession } from "../features/replay-page/replayModel";
import { useBookReplayStore } from "./bookReplay";
import { useUiStore } from "./ui";

export interface TickReplayTarget {
  readonly cellId: WindowId;
  readonly symbol: SymbolCode;
  readonly link: LinkColor | null;
  readonly date: string;
  readonly initialSec: number;
  readonly autoPlay: boolean;
}

export type TickReplayLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "empty"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export interface ActiveTickReplayState {
  readonly kind: "active";
  readonly runId: number;
  readonly target: TickReplayTarget;
  readonly load: TickReplayLoadState;
  readonly session: ReplaySession | null;
  readonly engine: ReplayEngine | null;
  readonly isArchive: boolean;
  readonly control: ReplayEngineControlState;
}

export type TickReplayState =
  | { readonly kind: "idle" }
  | ActiveTickReplayState;

export interface AttachTickReplayEngineInput {
  readonly session: ReplaySession;
  readonly engine: ReplayEngine;
  readonly isArchive: boolean;
}

interface TickReplayStore {
  readonly state: TickReplayState;
  start(target: TickReplayTarget): number;
  attachEngine(runId: number, input: AttachTickReplayEngineInput): void;
  updateSession(runId: number, session: ReplaySession, isArchive: boolean): void;
  setLoad(runId: number, load: TickReplayLoadState): void;
  setControl(runId: number, control: ReplayEngineControlState): void;
  stop(): void;
}

const IDLE_STATE: TickReplayState = { kind: "idle" };

let nextRunId = 0;

function initialControl(initialSec: number): ReplayEngineControlState {
  return {
    playing: false,
    buffering: true,
    mode: { kind: "time", speed: 1, skipIdleMs: null },
    activeSecond: Math.max(0, Math.floor(initialSec)),
    loadedSpanCount: 0,
  };
}

function sameControl(a: ReplayEngineControlState, b: ReplayEngineControlState): boolean {
  if (
    a.playing !== b.playing
    || a.buffering !== b.buffering
    || a.activeSecond !== b.activeSecond
    || a.loadedSpanCount !== b.loadedSpanCount
    || a.mode.kind !== b.mode.kind
  ) {
    return false;
  }
  if (a.mode.kind === "time" && b.mode.kind === "time") {
    return a.mode.speed === b.mode.speed && a.mode.skipIdleMs === b.mode.skipIdleMs;
  }
  if (a.mode.kind === "tick" && b.mode.kind === "tick") {
    return a.mode.rateHz === b.mode.rateHz && a.mode.filter === b.mode.filter;
  }
  return false;
}

function clearBookReplayForTickReplay(): void {
  replayPointScheduler.cancel();
  useUiStore.getState().setBookReplay(false);
  useBookReplayStore.getState().clear();
}

export const useTickReplayStore = create<TickReplayStore>()((set, get) => ({
  state: IDLE_STATE,
  start: (target) => {
    const prev = get().state;
    if (prev.kind === "active" && prev.engine !== null) {
      prev.engine.dispose();
    }
    clearBookReplayForTickReplay();
    const runId = ++nextRunId;
    set({
      state: {
        kind: "active",
        runId,
        target,
        load: { kind: "loading" },
        session: null,
        engine: null,
        isArchive: false,
        control: initialControl(target.initialSec),
      },
    });
    return runId;
  },
  attachEngine: (runId, { session, engine, isArchive }) => {
    const current = get().state;
    if (current.kind !== "active" || current.runId !== runId) {
      engine.dispose();
      return;
    }
    if (current.engine !== null && current.engine !== engine) {
      current.engine.dispose();
    }
    set({
      state: {
        ...current,
        load: { kind: "ready" },
        session,
        engine,
        isArchive,
        control: engine.getControlState(),
      },
    });
  },
  updateSession: (runId, session, isArchive) => {
    set((store) => {
      if (store.state.kind !== "active" || store.state.runId !== runId) return store;
      if (store.state.session === session && store.state.isArchive === isArchive) return store;
      return { state: { ...store.state, session, isArchive } };
    });
  },
  setLoad: (runId, load) => {
    set((store) => {
      if (store.state.kind !== "active" || store.state.runId !== runId) return store;
      return { state: { ...store.state, load } };
    });
  },
  setControl: (runId, control) => {
    set((store) => {
      if (store.state.kind !== "active" || store.state.runId !== runId) return store;
      if (sameControl(store.state.control, control)) return store;
      return { state: { ...store.state, control } };
    });
  },
  stop: () => {
    const prev = get().state;
    if (prev.kind === "idle") return;
    if (prev.engine !== null) {
      prev.engine.dispose();
    }
    set({ state: IDLE_STATE });
  },
}));

export function exitActiveReplay(): void {
  if (useTickReplayStore.getState().state.kind === "active") {
    useTickReplayStore.getState().stop();
    return;
  }
  clearBookReplayForTickReplay();
}
