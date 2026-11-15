import { type RefObject, useRef } from "react";
import type { DockSpace, Edge } from "../../layout/dock/geometry";
import { groupOfWindow, listGroups } from "../../layout/dock/tree";
import { WINDOW_KINDS } from "../../layout/kinds";
import type { DockPlacement } from "../../layout/placement";
import { chartNumber, chartWindows, useLayoutStore } from "../../stores/layout";
import { Menu, type MenuItem } from "../menu/Menu";
import { closeWindow, LAST_CHART_REASON } from "./manage";
import { evaluateDock, EDGE_LABEL, type DockCommand } from "./dockCommands";
import { focusTab, type DockInteraction } from "./dockInteraction";

export function DockTabMenu({ interaction, dock, space, root }: { interaction: DockInteraction; dock: DockPlacement; space: DockSpace; root: RefObject<HTMLElement | null> }) {
  const acted = useRef(false);
  const menu = interaction.menu;
  const layout = useLayoutStore((s) => s.layout);
  const canUndo = useLayoutStore((s) => s.steps.length > 0);
  if (!menu) return null;
  const window = layout.windows.find((window) => window.id === menu.window);
  const source = groupOfWindow(dock.root, menu.window);
  if (!window || !source) return null;
  const tabName = (id: typeof window.id) => Array.from(document.getElementById(`window-tab-${id}`)?.querySelectorAll(".dock-tab-name,.dock-tab-sub") ?? []).map((part) => part.textContent).join(" ");
  const name = window.kind === "chart" ? `칸 ${chartNumber(layout, window.id)} ${document.getElementById(`window-tab-${window.id}`)?.querySelector(".dock-tab-name")?.textContent ?? window.symbol}` : WINDOW_KINDS[window.kind].name;
  const action = (label: string, command: DockCommand): MenuItem => {
    const plan = evaluateDock(dock, command, space);
    const hint = plan.kind === "blocked" ? plan.label : plan.kind === "unchanged" ? "이 묶음에 다른 탭이 있어야 나눌 수 있습니다" : undefined;
    return { kind: "action", label, disabled: plan.kind !== "change", hint, onSelect: () => { acted.current = true; interaction.execute(command); } };
  };
  const edges: Edge[] = ["left", "right", "top", "bottom"];
  const items: MenuItem[] = edges.map((edge) => action(EDGE_LABEL[edge], { kind: "group-edge", window: window.id, group: source.id, edge }));
  const destinations = listGroups(dock.root).filter((group) => group.id !== source.id);
  if (destinations.length) {
    items.push({ kind: "separator" }, { kind: "heading", label: "다른 묶음으로 옮기기" });
    destinations.forEach((group) => items.push(action(tabName(group.active), { kind: "tab", window: window.id, group: group.id })));
  }
  items.push({ kind: "separator" }, { kind: "action", label: "배치 되돌리기", disabled: !canUndo, onSelect: () => {
    acted.current = true;
    useLayoutStore.getState().undoArrangement();
    focusTab(window.id);
  } });
  const lastChart = window.kind === "chart" && chartWindows(layout).length <= 1;
  items.push({ kind: "separator" }, { kind: "action", label: "닫기", danger: true, disabled: lastChart, hint: lastChart ? LAST_CHART_REASON : undefined, onSelect: () => {
    acted.current = true;
    closeWindow(window.id, name);
    const next = groupOfWindow(useLayoutStore.getState().layout.placement.dock?.root ?? dock.root, source.tabs.find((id) => id !== window.id) ?? window.id);
    if (next) focusTab(next.active);
    else requestAnimationFrame(() => document.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus());
  } });
  return <Menu label="창 배치" root={root} items={items} style={{ left: menu.x, top: menu.y }} onClose={() => {
    interaction.setMenu(null);
    if (!acted.current) focusTab(window.id);
  }} />;
}
