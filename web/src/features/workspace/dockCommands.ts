import { dockLevels, levelAtDistance, splitLevel, type DockLevelKind } from "../../layout/dock/levels";
import { dropTarget, EDGE_ZONE_SHARE, layoutDock, wholePixels, type DockSpace, type Edge, type GroupBox } from "../../layout/dock/geometry";
import { splitArea } from "../../layout/dock/split";
import { groupOfWindow, putTab, withoutWindow } from "../../layout/dock/tree";
import type { WindowId } from "../../layout/kinds";
import type { DockPlacement, Rect } from "../../layout/placement";

export type DockCommand =
  | { kind: "tab"; window: WindowId; group: string; at?: number }
  | { kind: "group-edge"; window: WindowId; group: string; edge: Edge; level?: number }
  | { kind: "area-edge"; window: WindowId; edge: Edge; group?: string };

export type DockLevelStep = { kind: DockLevelKind; groupCount: number };
export type DockLevelView = { rect: Rect; steps: DockLevelStep[]; current: number };

export type DockPlan =
  | { kind: "unchanged" }
  | { kind: "blocked"; rect: Rect; label: string; levels?: DockLevelView }
  | { kind: "change"; dock: DockPlacement; rect: Rect; label: string; levels?: DockLevelView };

export const SMALL_DOCK_NOTICE = "자리가 작아 나눌 수 없습니다. 가운데에 놓아 탭으로 넣으세요";
export const EDGE_LABEL: Record<Edge, string> = { left: "왼쪽에 나눠 놓기", right: "오른쪽에 나눠 놓기", top: "위에 나눠 놓기", bottom: "아래에 나눠 놓기" };

export function levelStepName(step: DockLevelStep): string {
  return step.kind === "group" ? "묶음" : step.kind === "split" ? `묶음 ${step.groupCount}개` : "화면 전체";
}

function edgeLabel(edge: Edge, step: DockLevelStep | undefined): string {
  if (!step || step.kind === "group") return EDGE_LABEL[edge];
  return `${step.kind === "split" ? `묶음 ${step.groupCount}개 전체` : "화면 전체"} ${EDGE_LABEL[edge]}`;
}

export function evaluateDock(dock: DockPlacement, command: DockCommand, space: DockSpace): DockPlan {
  const source = groupOfWindow(dock.root, command.window);
  if (!source && !dock.floats.some((float) => float.window === command.window)) return { kind: "unchanged" };
  if (command.kind === "tab" && source?.id === command.group) {
    const rest = source.tabs.filter((id) => id !== command.window);
    const at = Math.max(0, Math.min(command.at ?? rest.length, rest.length));
    const tabs = [...rest.slice(0, at), command.window, ...rest.slice(at)];
    if (tabs.every((id, index) => id === source.tabs[index])) return { kind: "unchanged" };
  }
  const withoutSource = command.kind === "tab" ? null : withoutWindow(dock, command.window);
  const steps = withoutSource && command.kind !== "tab" && command.group ? dockLevels(withoutSource.root, command.group, command.edge, wholePixels(space)) : [];
  const areaStep = command.kind === "area-edge" && steps[steps.length - 1]?.kind === "area";
  const index = command.kind === "group-edge" ? Math.max(0, Math.min(command.level ?? 0, steps.length - 1)) : steps.length - 1;
  const chosen = command.kind === "group-edge" || areaStep ? steps[index] : undefined;
  const levels: DockLevelView | undefined = chosen && { rect: chosen.rect, steps: steps.map(({ kind, groupCount }) => ({ kind, groupCount })), current: index };
  const result = command.kind === "tab"
    ? { ok: true, dock: putTab(dock, command.window, command.group, command.at) }
    : command.kind === "group-edge"
      ? splitLevel(dock, command.window, command.group, command.edge, index, space)
      : splitArea(dock, command.window, command.edge, space);
  if (!result.ok) {
    const rect = command.kind === "group-edge"
      ? levels?.rect ?? layoutDock(dock.root, space.area, space.gap).groups.find(({ group }) => group.id === command.group)?.rect
      : { x: 0, y: 0, ...space.area };
    return { kind: "blocked", rect: rect ?? { x: 0, y: 0, ...space.area }, label: SMALL_DOCK_NOTICE, levels };
  }
  if (result.dock === dock || JSON.stringify(result.dock) === JSON.stringify(dock)) return { kind: "unchanged" };
  const box = layoutDock(result.dock.root, space.area, space.gap).groups.find(({ group }) => group.tabs.includes(command.window));
  if (!box) return { kind: "unchanged" };
  const label = command.kind === "tab" ? "이 묶음에 탭으로 넣기" : edgeLabel(command.edge, command.kind === "area-edge" ? { kind: "area", groupCount: 0 } : chosen);
  return { kind: "change", dock: result.dock, rect: box.rect, label, levels };
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
  const boxes = layoutDock(dock.root, space.area, space.gap).groups;
  const box = groupNear(boxes, local);
  const edges: [Edge, number][] = [["left", local.x], ["right", space.area.w - local.x], ["top", local.y], ["bottom", space.area.h - local.y]];
  const [edge, distance] = edges.reduce((near, next) => next[1] < near[1] ? next : near);
  if (distance < 24) return { kind: "area-edge", window, edge, group: box?.group.id };
  if (reorder) return reorder;
  if (!box) return null;
  const levelCount = (side: Edge) => Math.max(1, levelCountOf(dock, window, box.group.id, side, space));
  if (!containsPoint(box.rect, local)) {
    const side = overshootEdge(box.rect, local);
    return { kind: "group-edge", window, group: box.group.id, edge: side, level: levelCount(side) - 1 };
  }
  const { zone } = dropTarget(box.rect, local);
  if (zone === "center") return { kind: "tab", window, group: box.group.id };
  const horizontal = zone === "left" || zone === "right";
  const distanceFromLine = { left: local.x - box.rect.x, right: box.rect.x + box.rect.w - local.x, top: local.y - box.rect.y, bottom: box.rect.y + box.rect.h - local.y }[zone];
  const bandDepth = EDGE_ZONE_SHARE * (horizontal ? box.rect.w : box.rect.h);
  return { kind: "group-edge", window, group: box.group.id, edge: zone, level: levelAtDistance(distanceFromLine, bandDepth, levelCount(zone)) };
}

const containsPoint = (rect: Rect, point: { x: number; y: number }) => point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h;

function groupNear(boxes: readonly GroupBox[], point: { x: number; y: number }): GroupBox | undefined {
  const gap = (box: GroupBox) => Math.hypot(Math.max(box.rect.x - point.x, 0, point.x - (box.rect.x + box.rect.w)), Math.max(box.rect.y - point.y, 0, point.y - (box.rect.y + box.rect.h)));
  return boxes.reduce<GroupBox | undefined>((near, next) => (!near || gap(next) < gap(near) ? next : near), undefined);
}

function overshootEdge(rect: Rect, point: { x: number; y: number }): Edge {
  const overshoot: [Edge, number][] = [["left", rect.x - point.x], ["right", point.x - (rect.x + rect.w)], ["top", rect.y - point.y], ["bottom", point.y - (rect.y + rect.h)]];
  return overshoot.reduce((far, next) => (next[1] > far[1] ? next : far))[0];
}

function levelCountOf(dock: DockPlacement, window: WindowId, group: string, edge: Edge, space: DockSpace): number {
  const rest = withoutWindow(dock, window);
  return rest ? dockLevels(rest.root, group, edge, wholePixels(space)).length : 0;
}
