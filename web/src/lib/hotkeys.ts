import type { PeriodOn } from "./symbol";

/** 단축키 표(frontend.md §3.2)의 #2 부분. 한글 입력 상태에서도 같게 동작하도록 event.code로 판단한다. */
export type HotkeyAction =
  | { kind: "search" }
  | { kind: "period"; period: PeriodOn }
  | { kind: "periodStep"; step: -1 | 1 }
  | { kind: "toggleLog" };

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const HOTKEYS: { keys: string; label: string; action: HotkeyAction; match: (e: KeyLike) => boolean }[] = (() => {
  const plain = (code: string) => (e: KeyLike) => e.code === code && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  return [
    { keys: "/", label: "종목 검색", action: { kind: "search" }, match: plain("Slash") },
    { keys: "Ctrl+K", label: "종목 검색", action: { kind: "search" }, match: (e) => e.code === "KeyK" && (e.ctrlKey || e.metaKey) && !e.altKey },
    { keys: "D", label: "일", action: { kind: "period", period: "D" }, match: plain("KeyD") },
    { keys: "W", label: "주", action: { kind: "period", period: "W" }, match: plain("KeyW") },
    { keys: "M", label: "월", action: { kind: "period", period: "M" }, match: plain("KeyM") },
    { keys: "[", label: "이전 봉 주기", action: { kind: "periodStep", step: -1 }, match: plain("BracketLeft") },
    { keys: "]", label: "다음 봉 주기", action: { kind: "periodStep", step: 1 }, match: plain("BracketRight") },
    { keys: "L", label: "로그 축 켜기/끄기", action: { kind: "toggleLog" }, match: plain("KeyL") },
  ];
})();

export function matchHotkey(e: KeyLike): HotkeyAction | null {
  return HOTKEYS.find((h) => h.match(e))?.action ?? null;
}

/** 입력칸에 초점이 있으면 단축키를 쓰지 않는다. */
export function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
