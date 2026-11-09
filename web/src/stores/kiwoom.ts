import { create } from "zustand";

interface KiwoomState {
  /**
   * 서버가 키움 인증 거절(`kiwoom_auth_failed`)을 알린 문장. 원인과 조치가 들어 있다(8050이면 공인 IP 등록).
   * 서버는 다시 켜야 풀리므로 이 페이지에서는 지우지 않는다.
   */
  authFailure: string | null;
  reportAuthFailure(message: string): void;
}

export const useKiwoomStore = create<KiwoomState>()((set) => ({
  authFailure: null,
  reportAuthFailure: (message) => set((s) => (s.authFailure === message ? s : { authFailure: message })),
}));
