import { create } from "zustand";

interface HotkeyRecording {
  actionId: string | null;
  start(actionId: string): void;
  stop(): void;
}

export const useHotkeyRecording = create<HotkeyRecording>()((set) => ({
  actionId: null,
  start: (actionId) => set({ actionId }),
  stop: () => set({ actionId: null }),
}));

export const cancelHotkeyRecording = (): boolean => {
  if (useHotkeyRecording.getState().actionId === null) return false;
  useHotkeyRecording.getState().stop();
  return true;
};
