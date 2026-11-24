import { type RefObject, useRef } from "react";
import { LAST_DOCKED_NOTICE } from "../../layout/dock/floats";
import type { Edge } from "../../layout/dock/geometry";
import { groupOfWindow, listGroups } from "../../layout/dock/tree";
import { allowsMany, MAX_WINDOWS } from "../../layout/kinds";
import type { DockPlacement } from "../../layout/placement";
import { chartNumber, chartWindows, useLayoutStore, windowName } from "../../stores/layout";
import { touchWindow } from "../../stores/activeWindow";
import { Menu, type MenuItem } from "../menu/Menu";
import { closeWindow, LAST_CHART_REASON, WINDOW_LIMIT_REASON } from "./manage";
import { EDGE_LABEL, type DockCommand } from "./dockCommands";
import { focusTab, type DockInteraction } from "./dockInteraction";
import { focusWithoutActivation, tabLabel } from "./focus";
import { mergeRepeatedReasons } from "./menuReasons";

const FOLDED_ORDER_REASON = "자리가 좁아 접혀 들어온 탭과는 순서를 바꿀 수 없습니다";

export function DockTabMenu({ interaction, dock, root, maximized, onToggleMaximize }: { interaction: DockInteraction; dock: DockPlacement; root: RefObject<HTMLElement | null>; maximized: string | null; onToggleMaximize(group: string): void }) {
  const acted = useRef(false);
  const menu = interaction.menu;
  const layout = useLayoutStore((s) => s.layout);
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  if (!menu) return null;
  const window = layout.windows.find((window) => window.id === menu.window);
  const source = groupOfWindow(dock.root, menu.window);
  if (!window || !source) return null;
  const name = window.kind === "chart" ? `칸 ${chartNumber(layout, window.id)} ${document.getElementById(`window-tab-${window.id}`)?.querySelector(".dock-tab-name")?.textContent ?? window.symbol}` : windowName(layout.windows, window);
  const action = (label: string, command: DockCommand): MenuItem => {
    const plan = interaction.plan(command);
    const disabledReason = plan.kind === "blocked" ? plan.label : plan.kind === "unchanged" ? "이 묶음에 다른 탭이 있어야 나눌 수 있습니다" : undefined;
    return { kind: "action", label, disabled: plan.kind !== "change", disabledReason, onSelect: () => { acted.current = true; interaction.execute(command); } };
  };
  const edges: Edge[] = ["left", "right", "top", "bottom"];
  const items: MenuItem[] = edges.map((edge) => action(EDGE_LABEL[edge], { kind: "group-edge", window: window.id, group: source.id, edge }));
  items.unshift({ kind: "action", label: maximized === source.id ? "원래 크기로" : "크게 보기", shortcut: maximized === source.id ? "Esc" : "더블클릭", onSelect: () => { acted.current = true; onToggleMaximize(source.id); focusTab(window.id); } }, { kind: "action", label: "띄우기", disabled: !interaction.canDetach(window.id), disabledReason: !interaction.canDetach(window.id) ? LAST_DOCKED_NOTICE : undefined, onSelect: () => { acted.current = true; interaction.detach(window.id); } }, { kind: "separator" });
  if (window.kind !== "chart" && allowsMany(window.kind)) {
    const full = layout.windows.length >= MAX_WINDOWS;
    items.push({ kind: "separator" }, { kind: "action", label: "복제", disabled: full, disabledReason: full ? WINDOW_LIMIT_REASON : undefined, onSelect: () => {
      acted.current = true;
      const copy = useLayoutStore.getState().duplicateWindow(window.id);
      if (copy) {
        touchWindow(copy);
        focusTab(copy);
      }
    } });
  }
  if (source.tabs.length > 1) {
    const index = source.tabs.indexOf(window.id);
    const shift = (label: string, shortcut: string, to: number): MenuItem => {
      const outside = to < 0 || to >= source.tabs.length;
      const folded = !outside && interaction.plan({ kind: "tab", window: window.id, group: source.id, at: to }).kind !== "change";
      return { kind: "action", label, shortcut, disabled: outside || folded, disabledReason: folded ? FOLDED_ORDER_REASON : undefined, onSelect: () => { acted.current = true; interaction.execute({ kind: "tab", window: window.id, group: source.id, at: to }); } };
    };
    items.push({ kind: "separator" }, shift("앞으로 옮기기", "Alt+←", index - 1), shift("뒤로 옮기기", "Alt+→", index + 1));
  }
  const destinations = listGroups(dock.root).filter((group) => group.id !== source.id);
  if (destinations.length) {
    items.push({ kind: "separator" }, { kind: "heading", label: "다른 묶음으로 옮기기" });
    destinations.forEach((group) => items.push(action(tabLabel(group.active), { kind: "tab", window: window.id, group: group.id })));
  }
  items.push({ kind: "separator" }, { kind: "action", label: "배치 되돌리기", disabled: !canUndo, onSelect: () => {
    acted.current = true;
    useLayoutStore.getState().undoArrangement();
    focusTab(window.id);
  } });
  const lastChart = window.kind === "chart" && chartWindows(layout).length <= 1;
  items.push({ kind: "separator" }, { kind: "action", label: "닫기", danger: true, disabled: lastChart, disabledReason: lastChart ? LAST_CHART_REASON : undefined, onSelect: () => {
    acted.current = true;
    closeWindow(window.id, name);
    const next = groupOfWindow(useLayoutStore.getState().layout.placement.dock?.root ?? dock.root, source.tabs.find((id) => id !== window.id) ?? window.id);
    if (next) focusTab(next.active);
    else requestAnimationFrame(() => focusWithoutActivation(document.querySelector<HTMLElement>('[role=tab][aria-selected=true]')));
  } });
  return <Menu label="창 배치" root={root} items={mergeRepeatedReasons(items)} style={{ left: menu.x, top: menu.y }} onClose={() => {
    interaction.setMenu(null);
    if (!acted.current) focusTab(window.id);
  }} />;
}
