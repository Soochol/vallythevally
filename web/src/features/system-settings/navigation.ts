import { FIRST_MENU, type SystemMenuId } from "./menus";

export interface Navigation {
  selected: SystemMenuId;
  view: "list" | "content";
}

export type NavigationAction = { type: "choose"; menu: SystemMenuId } | { type: "move"; menu: SystemMenuId } | { type: "back" };

export type FocusTarget = { kind: "title" } | { kind: "tab"; menu: SystemMenuId };

export const openNavigation = (menu: SystemMenuId | null): Navigation => ({ selected: menu ?? FIRST_MENU, view: menu ? "content" : "list" });

export function navigate(state: Navigation, action: NavigationAction): Navigation {
  switch (action.type) {
    case "choose":
      return { selected: action.menu, view: "content" };
    case "move":
      return { ...state, selected: action.menu };
    case "back":
      return { ...state, view: "list" };
  }
}

export function focusTarget(state: Navigation, desktop: boolean): FocusTarget {
  return !desktop && state.view === "content" ? { kind: "title" } : { kind: "tab", menu: state.selected };
}
