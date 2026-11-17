import { create } from "zustand";
import type { DocumentKind } from "../api/generated/DocumentKind";
import { usePersistStore } from "./persist";

interface SetupChangeStore {
  kinds: readonly DocumentKind[];
  receive(kinds: readonly DocumentKind[]): void;
}

export const useSetupChangeStore = create<SetupChangeStore>()((set) => ({
  kinds: [],
  receive: (received) => set((s) => ({ kinds: [...new Set([...s.kinds, ...received])] })),
}));

export const receiveSetupChanged = (kinds: readonly DocumentKind[]) => {
  if (usePersistStore.getState().phase.kind !== "ready") return;
  useSetupChangeStore.getState().receive(kinds);
};
