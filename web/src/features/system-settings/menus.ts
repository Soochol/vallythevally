export const SYSTEM_MENUS = [
  { id: "kiwoom", label: "증권사 · 계좌", ready: true },
  { id: "general", label: "일반", ready: true },
  { id: "hotkeys", label: "단축키", ready: true },
  { id: "telegram", label: "알림 · 텔레그램", ready: false },
  { id: "data", label: "데이터 · 저장소", ready: true },
  { id: "collector", label: "수집 현황판", ready: true },
  { id: "account", label: "계정", ready: true },
  { id: "about", label: "정보", ready: true },
] as const;

export type SystemMenuId = (typeof SYSTEM_MENUS)[number]["id"];

export type SystemMenu = (typeof SYSTEM_MENUS)[number];

export const visibleMenus = (collectorAllowed: boolean): readonly SystemMenu[] => SYSTEM_MENUS.filter((m) => m.id !== "collector" || collectorAllowed);

export const FIRST_MENU: SystemMenuId = "kiwoom";

export function menuAfterKey(current: SystemMenuId, key: string, menus: readonly SystemMenu[] = visibleMenus(false)): SystemMenuId | null {
  const selectable = menus.filter((m) => m.ready).map((m) => m.id as SystemMenuId);
  const at = selectable.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return selectable[Math.min(selectable.length - 1, at + 1)] ?? null;
    case "ArrowUp":
      return selectable[Math.max(0, at - 1)] ?? null;
    case "Home":
      return selectable[0] ?? null;
    case "End":
      return selectable.at(-1) ?? null;
    default:
      return null;
  }
}
