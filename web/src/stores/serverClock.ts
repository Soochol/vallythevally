import { create } from "zustand";

interface ServerClockState {
  serverTimeOrigin: number | null;
  observe(date: string | null, receivedAt: number): void;
}

export const useServerClock = create<ServerClockState>()((set) => ({
  serverTimeOrigin: null,
  observe: (date, receivedAt) => {
    const sentAt = date === null ? Number.NaN : Date.parse(date);
    if (Number.isNaN(sentAt)) return;
    const origin = sentAt - receivedAt;
    set((s) => (s.serverTimeOrigin !== null && s.serverTimeOrigin >= origin ? s : { serverTimeOrigin: origin }));
  },
}));

export const serverNow = (serverTimeOrigin: number | null): number => (serverTimeOrigin === null ? Date.now() : serverTimeOrigin + performance.now());
