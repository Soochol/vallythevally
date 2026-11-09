import { create } from "zustand";

interface KiwoomState {
  authFailure: string | null;
  reportAuthFailure(message: string): void;
}

export const useKiwoomStore = create<KiwoomState>()((set) => ({
  authFailure: null,
  reportAuthFailure: (message) => set((s) => (s.authFailure === message ? s : { authFailure: message })),
}));
