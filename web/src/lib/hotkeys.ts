import type { Period } from "../api/generated/Period";

/** 단축키 표(frontend.md §3.2) 가운데 지금 켜진 것. 한글 입력 상태에서도 같게 동작하도록 event.code로 판단한다. */
export type HotkeyAction =
  | { kind: "search" }
  | { kind: "period"; period: Period }
  | { kind: "periodStep"; step: -1 | 1 }
  | { kind: "toggleLog" }
  | { kind: "toggleWatch" };

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const HOTKEYS: { keys: string; label: string; action: HotkeyAction; match: (e: KeyLike) => boolean }[] = (() => {
  const plain = (code: string) => (e: KeyLike) => e.code === code && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  const shifted = (code: string) => (e: KeyLike) => e.code === code && !e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey;
  return [
    { keys: "/", label: "종목 검색", action: { kind: "search" }, match: plain("Slash") },
    { keys: "Ctrl+K", label: "종목 검색", action: { kind: "search" }, match: (e) => e.code === "KeyK" && (e.ctrlKey || e.metaKey) && !e.altKey },
    { keys: "1", label: "1분", action: { kind: "period", period: "1m" }, match: plain("Digit1") },
    { keys: "3", label: "3분", action: { kind: "period", period: "3m" }, match: plain("Digit3") },
    { keys: "5", label: "5분", action: { kind: "period", period: "5m" }, match: plain("Digit5") },
    { keys: "Shift+1", label: "15분", action: { kind: "period", period: "15m" }, match: shifted("Digit1") },
    { keys: "Shift+3", label: "30분", action: { kind: "period", period: "30m" }, match: shifted("Digit3") },
    { keys: "Shift+6", label: "60분", action: { kind: "period", period: "60m" }, match: shifted("Digit6") },
    { keys: "D", label: "일", action: { kind: "period", period: "D" }, match: plain("KeyD") },
    { keys: "W", label: "주", action: { kind: "period", period: "W" }, match: plain("KeyW") },
    { keys: "M", label: "월", action: { kind: "period", period: "M" }, match: plain("KeyM") },
    { keys: "[", label: "이전 봉 주기", action: { kind: "periodStep", step: -1 }, match: plain("BracketLeft") },
    { keys: "]", label: "다음 봉 주기", action: { kind: "periodStep", step: 1 }, match: plain("BracketRight") },
    { keys: "L", label: "로그 축 켜기/끄기", action: { kind: "toggleLog" }, match: plain("KeyL") },
    {
      keys: "Alt+W",
      label: "관심종목 접기/펴기",
      action: { kind: "toggleWatch" },
      match: (e) => e.code === "KeyW" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey,
    },
  ];
})();

export function periodKey(p: Period): string | undefined {
  return HOTKEYS.find((h) => h.action.kind === "period" && h.action.period === p)?.keys;
}

export function matchHotkey(e: KeyLike): HotkeyAction | null {
  return HOTKEYS.find((h) => h.match(e))?.action ?? null;
}

/** 입력칸에 초점이 있으면 단축키를 쓰지 않는다. */
export function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
