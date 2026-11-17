import { create } from "zustand";
import type { DocumentKind } from "../api/generated/DocumentKind";
import { useAccountStore } from "./account";

export const QUIET_AFTER_CHOICE_MS = 5_000;

interface SetupChangeStore {
  kinds: readonly DocumentKind[];
  quietUntil: number;
  receive(kinds: readonly DocumentKind[]): void;
  dismiss(): void;
  settleChoice(): void;
}

export const useSetupChangeStore = create<SetupChangeStore>()((set) => ({
  kinds: [],
  quietUntil: 0,
  receive: (received) => set((s) => ({ kinds: [...new Set([...s.kinds, ...received])] })),
  dismiss: () => set({ kinds: [] }),
  settleChoice: () => set({ kinds: [], quietUntil: performance.now() + QUIET_AFTER_CHOICE_MS }),
}));

export const receiveSetupChanged = (kinds: readonly DocumentKind[]) => {
  const account = useAccountStore.getState().status;
  if (account?.state === "signed_in" && account.sync.state === "needs_choice") return;
  if (performance.now() < useSetupChangeStore.getState().quietUntil) return;
  useSetupChangeStore.getState().receive(kinds);
};
