import { create } from "zustand";

interface KiwoomState {
  stopped: string | null;
  notice: string | null;
  reportStopped(message: string): void;
  reportNotice(message: string): void;
  clearNotice(): void;
}

export const useKiwoomStore = create<KiwoomState>()((set) => ({
  stopped: null,
  notice: null,
  reportStopped: (message) => set((s) => (s.stopped === message ? s : { stopped: message })),
  reportNotice: (message) => set((s) => (s.notice === message ? s : { notice: message })),
  clearNotice: () => set((s) => (s.notice === null ? s : { notice: null })),
}));
