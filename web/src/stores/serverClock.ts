import { create } from "zustand";

interface ServerClockState {
  serverAheadMs: number;
  observe(date: string | null, receivedAt: number): void;
}

export const useServerClock = create<ServerClockState>()((set) => ({
  serverAheadMs: 0,
  observe: (date, receivedAt) => {
    const sentAt = date === null ? Number.NaN : Date.parse(date);
    if (Number.isNaN(sentAt)) return;
    const serverAheadMs = sentAt - receivedAt;
    set((s) => (s.serverAheadMs === serverAheadMs ? s : { serverAheadMs }));
  },
}));
