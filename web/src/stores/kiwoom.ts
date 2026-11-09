import { create } from "zustand";

interface KiwoomState {
  /** 사람이 고치고 서버를 다시 켜야 풀리는 실패. 지우지 않는다. */
  stopped: string | null;
  /** 지나갈 수 있는 안내(응답 시간 초과). 다음 성공 응답에서 지운다. */
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
