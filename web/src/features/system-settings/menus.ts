export const SYSTEM_MENUS = [
  { id: "kiwoom", label: "키움 연결", ready: true },
  { id: "general", label: "일반", ready: true },
  { id: "telegram", label: "알림 · 텔레그램", ready: false },
  { id: "dart", label: "재무자료 · DART", ready: false },
  { id: "data", label: "데이터 · 저장소", ready: true },
  { id: "account", label: "계정", ready: true },
  { id: "about", label: "정보", ready: true },
] as const;

export type SystemMenuId = (typeof SYSTEM_MENUS)[number]["id"];

const SELECTABLE = SYSTEM_MENUS.filter((m) => m.ready).map((m) => m.id as SystemMenuId);

export const FIRST_MENU: SystemMenuId = "kiwoom";

export function menuAfterKey(current: SystemMenuId, key: string): SystemMenuId | null {
  const at = SELECTABLE.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return SELECTABLE[Math.min(SELECTABLE.length - 1, at + 1)] ?? null;
    case "ArrowUp":
      return SELECTABLE[Math.max(0, at - 1)] ?? null;
    case "Home":
      return SELECTABLE[0] ?? null;
    case "End":
      return SELECTABLE.at(-1) ?? null;
    default:
      return null;
  }
}
