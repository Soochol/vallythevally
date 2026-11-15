import { dropTarget, layoutDock, type DockSpace, type Edge } from "../../layout/dock/geometry";
import { splitArea, splitGroup } from "../../layout/dock/split";
import { groupOfWindow, putTab } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { DockPlacement, Rect } from "../../layout/placement";

export type DockCommand =
  | { kind: "tab"; window: WindowId; group: string; at?: number }
  | { kind: "group-edge"; window: WindowId; group: string; edge: Edge }
  | { kind: "area-edge"; window: WindowId; edge: Edge };

export type DockPlan =
  | { kind: "unchanged" }
  | { kind: "blocked"; rect: Rect; label: string }
  | { kind: "change"; dock: DockPlacement; rect: Rect; label: string };

export const SMALL_DOCK_NOTICE = "자리가 작아 나눌 수 없습니다. 가운데에 놓아 탭으로 넣으세요";
export const EDGE_LABEL: Record<Edge, string> = { left: "왼쪽에 나눠 놓기", right: "오른쪽에 나눠 놓기", top: "위에 나눠 놓기", bottom: "아래에 나눠 놓기" };

export function evaluateDock(dock: DockPlacement, command: DockCommand, space: DockSpace): DockPlan {
  const source = groupOfWindow(dock.root, command.window);
  if (!source && !dock.floats.some((float) => float.window === command.window)) return { kind: "unchanged" };
  if (command.kind === "tab" && source?.id === command.group) {
    const rest = source.tabs.filter((id) => id !== command.window);
    const at = Math.max(0, Math.min(command.at ?? rest.length, rest.length));
    const tabs = [...rest.slice(0, at), command.window, ...rest.slice(at)];
    if (tabs.every((id, index) => id === source.tabs[index])) return { kind: "unchanged" };
  }
  const result = command.kind === "tab"
    ? { ok: true, dock: putTab(dock, command.window, command.group, command.at) }
    : command.kind === "group-edge"
      ? splitGroup(dock, command.window, command.group, command.edge, space)
      : splitArea(dock, command.window, command.edge, space);
  if (!result.ok) {
    const rect = command.kind === "group-edge"
      ? layoutDock(dock.root, space.area, space.gap).groups.find(({ group }) => group.id === command.group)?.rect
      : { x: 0, y: 0, ...space.area };
    return { kind: "blocked", rect: rect ?? { x: 0, y: 0, ...space.area }, label: SMALL_DOCK_NOTICE };
  }
  if (result.dock === dock || JSON.stringify(result.dock) === JSON.stringify(dock)) return { kind: "unchanged" };
  const box = layoutDock(result.dock.root, space.area, space.gap).groups.find(({ group }) => group.tabs.includes(command.window));
  if (!box) return { kind: "unchanged" };
  return { kind: "change", dock: result.dock, rect: box.rect, label: command.kind === "tab" ? "이 묶음에 탭으로 넣기" : EDGE_LABEL[command.edge] };
}

export function commandAt(root: HTMLElement, dock: DockPlacement, window: WindowId, point: { x: number; y: number }, space: DockSpace, origin: { x: number; y: number }): DockCommand | null {
  const bounds = root.getBoundingClientRect();
  const local = { x: point.x - bounds.left, y: point.y - bounds.top };
  if (local.x < 0 || local.y < 0 || local.x >= space.area.w || local.y >= space.area.h) return null;
  let reorder: DockCommand | null = null;
  const source = groupOfWindow(dock.root, window);
  const strip = source && document.getElementById(`window-panel-${source.id}`)?.previousElementSibling;
  const stripBox = strip?.getBoundingClientRect();
  if (stripBox && point.x >= stripBox.left && point.x < stripBox.right && point.y >= stripBox.top && point.y < stripBox.bottom && source) {
    const rest = source.tabs.filter((id) => id !== window);
    const at = rest.findIndex((id) => {
      const box = document.getElementById(`window-tab-${id}`)?.getBoundingClientRect();
      if (!box) return false;
      const midpoint = box.left + box.width / 2;
      return point.x === midpoint ? point.x < origin.x : point.x < midpoint;
    });
    reorder = { kind: "tab", window, group: source.id, at: at < 0 ? rest.length : at };
  }
  if (reorder && Math.abs(point.x - origin.x) > Math.abs(point.y - origin.y)) return reorder;
  const edges: [Edge, number][] = [["left", local.x], ["right", space.area.w - local.x], ["top", local.y], ["bottom", space.area.h - local.y]];
  const [edge, distance] = edges.reduce((near, next) => next[1] < near[1] ? next : near);
  if (distance < 24) return { kind: "area-edge", window, edge };
  if (reorder) return reorder;
  const box = layoutDock(dock.root, space.area, space.gap).groups.find(({ rect }) => local.x >= rect.x && local.x < rect.x + rect.w && local.y >= rect.y && local.y < rect.y + rect.h);
  if (!box) return null;
  const { zone } = dropTarget(box.rect, local);
  return zone === "center" ? { kind: "tab", window, group: box.group.id } : { kind: "group-edge", window, group: box.group.id, edge: zone };
}
