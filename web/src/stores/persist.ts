import { create } from "zustand";
import type { SaveState } from "../persist/saver";

export type SaveTarget = "layout" | "ui" | "watchlist";

/** 첫 화면을 열기까지. `offline`이면 서버에 닿지 못해 기본 화면으로 열었고 저장하지 않는다. */
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
