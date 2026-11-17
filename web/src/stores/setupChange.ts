import { create } from "zustand";
import type { DocumentKind } from "../api/generated/DocumentKind";
import { useAccountStore } from "./account";

interface SetupChangeStore {
  kinds: readonly DocumentKind[];
  receive(kinds: readonly DocumentKind[]): void;
}

export const useSetupChangeStore = create<SetupChangeStore>()((set) => ({
  kinds: [],
  receive: (received) => set((s) => ({ kinds: [...new Set([...s.kinds, ...received])] })),
}));

export const receiveSetupChanged = (kinds: readonly DocumentKind[]) => {
  const account = useAccountStore.getState().status;
  if (account?.state === "signed_in" && account.sync.state === "needs_choice") return;
  useSetupChangeStore.getState().receive(kinds);
};
