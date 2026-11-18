import { create } from "zustand";
import type { KiwoomLinkStatus } from "../api/generated/KiwoomLinkStatus";

interface KiwoomLinkStore {
  status: KiwoomLinkStatus | null;
  pushes: number;
  receivePush(status: KiwoomLinkStatus): void;
  receiveSnapshot(status: KiwoomLinkStatus, pushesAtRequest: number): void;
}

export const useKiwoomLinkStore = create<KiwoomLinkStore>()((set) => ({
  status: null,
  pushes: 0,
  receivePush: (status) => set((s) => ({ status, pushes: s.pushes + 1 })),
  receiveSnapshot: (status, pushesAtRequest) => set((s) => (s.pushes === pushesAtRequest ? { status } : s)),
}));

export const isMockEnvironment = (): boolean => useKiwoomLinkStore.getState().status?.environment === "mock";
export const useMockEnvironment = (): boolean => useKiwoomLinkStore((s) => s.status?.environment === "mock");

export const receiveKiwoomLinkPush = (status: KiwoomLinkStatus) => useKiwoomLinkStore.getState().receivePush(status);
