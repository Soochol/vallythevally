import { create } from "zustand";

interface KiwoomState {
  /** 서버가 `kiwoom_auth_failed`로 알린 원인과 조치. 서버를 다시 켜야 풀리므로 이 페이지에서는 지우지 않는다. */
  authFailure: string | null;
  reportAuthFailure(message: string): void;
}

export const useKiwoomStore = create<KiwoomState>()((set) => ({
  authFailure: null,
  reportAuthFailure: (message) => set((s) => (s.authFailure === message ? s : { authFailure: message })),
}));
