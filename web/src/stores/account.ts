import { create } from "zustand";
import type { AccountStatus } from "../api/generated/AccountStatus";

interface AccountStore {
  status: AccountStatus | null;
  pushes: number;
  loginFailure: string | null;
  receivePush(status: AccountStatus): void;
  receiveSnapshot(status: AccountStatus, pushesAtRequest: number): void;
  showLoginFailure(text: string | null): void;
}

export const useAccountStore = create<AccountStore>()((set) => ({
  status: null,
  pushes: 0,
  loginFailure: null,
  receivePush: (status) => set((s) => ({ status, pushes: s.pushes + 1 })),
  receiveSnapshot: (status, pushesAtRequest) => set((s) => (s.pushes === pushesAtRequest ? { status } : s)),
  showLoginFailure: (loginFailure) => set({ loginFailure }),
}));

export const receiveAccountPush = (status: AccountStatus) => useAccountStore.getState().receivePush(status);
