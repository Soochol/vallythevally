import type { DockPlacement } from "../../layout/placement";
import { alongOf, gutterAt, leadRange } from "../../layout/dock/axis";
import { dockMinSize, layoutDock, ratioForLead, wholePixels, type DockSpace, type GutterBox } from "../../layout/dock/geometry";
import type { Junction } from "../../layout/dock/junction";
import { pushDivider } from "../../layout/dock/push";
import { dividerStops, snapLead, type Stop } from "../../layout/dock/stops";
import type { Branch } from "../../layout/dock/tree";

export type JunctionAxis = "row" | "column";
export type JunctionMove = { dock: DockPlacement; clamped: Record<JunctionAxis, Branch | null>; stops: Record<JunctionAxis, Stop | null>; boxes: Record<JunctionAxis, GutterBox> };
export type JunctionStart = { row: number; column: number };

const leadOf = (box: GutterBox) => (box.node.dir === "row" ? box.rect.x - box.bounds.x : box.rect.y - box.bounds.y);

export function junctionGutters(dock: DockPlacement, junction: Pick<Junction, "rowPath" | "columnPath">, space: DockSpace): Record<JunctionAxis, GutterBox> | null {
  const px = wholePixels(space);
  const layout = layoutDock(dock.root, px.area, px.gap);
  const row = gutterAt(layout, junction.rowPath);
  const column = gutterAt(layout, junction.columnPath);
  return row && column ? { row, column } : null;
}

export function junctionStart(dock: DockPlacement, junction: Pick<Junction, "rowPath" | "columnPath">, space: DockSpace): JunctionStart | null {
  const found = junctionGutters(dock, junction, space);
  return found && { row: leadOf(found.row), column: leadOf(found.column) };
}

function moveOne(dock: DockPlacement, junction: Pick<Junction, "rowPath" | "columnPath">, axis: JunctionAxis, rawLead: number, alt: boolean, space: DockSpace) {
  const px = wholePixels(space);
  const path = axis === "row" ? junction.rowPath : junction.columnPath;
  const box = gutterAt(layoutDock(dock.root, px.area, px.gap), path);
  const range = box && leadRange(box, px);
  if (!box || !range) return { dock, clamped: null, stop: null };
  const snapped = alt ? { lead: rawLead, stop: null } : snapLead(rawLead, dividerStops(dock, path, space));
  const next = pushDivider(dock, path, ratioForLead(snapped.lead, alongOf(box.node.dir, box.bounds), px.gap), space).dock;
  const clamped: Branch | null = rawLead < range.min ? "first" : rawLead > range.max ? "second" : null;
  return { dock: next, clamped, stop: snapped.stop };
}

export function moveJunction(dock: DockPlacement, junction: Pick<Junction, "rowPath" | "columnPath">, start: JunctionStart, delta: { x: number; y: number }, alt: boolean, space: DockSpace): JunctionMove | null {
  const sideways = moveOne(dock, junction, "row", start.row + delta.x, alt, space);
  const down = moveOne(sideways.dock, junction, "column", start.column + delta.y, alt, space);
  const boxes = junctionGutters(down.dock, junction, space);
  return boxes && { dock: down.dock, clamped: { row: sideways.clamped, column: down.clamped }, stops: { row: sideways.stop, column: down.stop }, boxes };
}

export function junctionStopNotice(box: GutterBox, space: DockSpace, shrinking: Branch): string {
  const row = box.node.dir === "row";
  const least = dockMinSize(box.node[shrinking], space);
  const side = row ? (shrinking === "first" ? "왼쪽" : "오른쪽") : shrinking === "first" ? "위쪽" : "아래쪽";
  return row ? `${side} 창은 폭 ${least.w}px보다 좁아지지 않습니다` : `${side} 창은 높이 ${least.h}px보다 낮아지지 않습니다`;
}
