import { placeNewWindow, rectsForArea } from "../canvas/arrange";
import { keepHeadInArea, toRatio, type Area } from "../canvas/geometry";
import type { WindowId, WindowRef } from "../kinds";
import type { DockPlacement, Rect } from "../placement";
import { fitDock, type WindowList } from "./fit";
import { layoutDock, type DockSpace } from "./geometry";
import { findGroup, groupOfWindow, listGroups, putTab, selectTab, withoutWindow } from "./tree";

export type DockOrigins = ReadonlyMap<WindowId, string>;
export const LAST_DOCKED_NOTICE = "마지막으로 도킹된 창은 띄울 수 없습니다";

export const canDetach = (dock: DockPlacement, window: WindowId): boolean => !!groupOfWindow(dock.root, window) && listGroups(dock.root).reduce((count, group) => count + group.tabs.length, 0) > 1;

export function detachWindow(dock: DockPlacement, window: WindowId, rect: Rect): DockPlacement {
  if (!canDetach(dock, window)) return dock;
  const rest = withoutWindow(dock, window);
  return rest ? { ...rest, floats: [...rest.floats, { window, rect }] } : dock;
}

export function moveFloat(dock: DockPlacement, window: WindowId, rect: Rect): DockPlacement {
  const float = dock.floats.find((float) => float.window === window);
  if (!float || (float.rect.x === rect.x && float.rect.y === rect.y && float.rect.w === rect.w && float.rect.h === rect.h)) return dock;
  return { ...dock, floats: dock.floats.map((float) => float.window === window ? { window, rect } : float) };
}

export function frontFloat(dock: DockPlacement, window: WindowId): DockPlacement {
  const float = dock.floats.find((float) => float.window === window);
  return !float || dock.floats.at(-1) === float ? dock : { ...dock, floats: [...dock.floats.filter((float) => float.window !== window), float] };
}

export function attachFloat(dock: DockPlacement, window: WindowId, origin: string | undefined, windows: WindowList): DockPlacement {
  if (!dock.floats.some((float) => float.window === window)) return dock;
  if (origin && findGroup(dock.root, origin)) return putTab(dock, window, origin);
  return selectTab(fitDock({ ...dock, floats: dock.floats.filter((float) => float.window !== window) }, windows), window);
}

export function reconcileOrigins(before: DockPlacement | null, next: DockPlacement | null, origins: DockOrigins): DockOrigins {
  const kept = new Map<WindowId, string>();
  if (!next) return kept;
  for (const { window } of next.floats) {
    const origin = origins.get(window) ?? (before && !before.floats.some((float) => float.window === window) ? groupOfWindow(before.root, window)?.id : undefined);
    if (origin && findGroup(next.root, origin)) kept.set(window, origin);
  }
  return kept;
}

export function floatRects(dock: DockPlacement, windows: readonly WindowRef[], area: Area): Record<WindowId, Rect> {
  return rectsForArea({ rects: Object.fromEntries(dock.floats.map(({ window, rect }) => [window, rect])), order: dock.floats.map(({ window }) => window) }, windows, area);
}

export function detachedRect(dock: DockPlacement, window: WindowId, space: DockSpace, area: Area, point?: { x: number; y: number }): Rect | null {
  const ref = space.windows.find((ref) => ref.id === window);
  if (!ref) return null;
  const base = placeNewWindow(ref.kind, Object.values(floatRects(dock, space.windows, area)), area);
  const group = layoutDock(dock.root, space.area, space.gap).groups.find(({ group }) => group.tabs.includes(window));
  const position = point ? { x: point.x - 80, y: point.y - 14 } : { x: (group?.rect.x ?? base.x) + 24, y: (group?.rect.y ?? base.y) + 24 };
  return toRatio(keepHeadInArea({ ...base, ...position }, area), area);
}
