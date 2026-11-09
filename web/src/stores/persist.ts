import { create } from "zustand";
import type { SaveState } from "../persist/saver";

export const SAVE_TARGETS = ["layout", "ui", "watchlist"] as const;
export type SaveTarget = (typeof SAVE_TARGETS)[number];

export type BootPhase = { kind: "restoring" } | { kind: "ready" } | { kind: "offline"; message: string };

interface PersistState {
  phase: BootPhase;
  saves: Record<SaveTarget, SaveState>;
  setPhase(phase: BootPhase): void;
  setSave(target: SaveTarget, state: SaveState): void;
}

const IDLE: SaveState = { kind: "idle" };

export const usePersistStore = create<PersistState>()((set) => ({
  phase: { kind: "restoring" },
  saves: { layout: IDLE, ui: IDLE, watchlist: IDLE },
  setPhase: (phase) => set({ phase }),
  setSave: (target, state) => set((s) => ({ saves: { ...s.saves, [target]: state } })),
}));
