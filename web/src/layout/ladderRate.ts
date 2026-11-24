import { rectsForArea } from "./canvas/arrange";
import { minWindowSize, workArea, type Area } from "./canvas/geometry";
import { carryRatios } from "./dock/carry";
import { shiftColumns, splitShape } from "./dock/columns";
import { fitDock, type WindowList } from "./dock/fit";
import { floatRects } from "./dock/floats";
import { isLadderKind, LADDER_RATE_WIDTH, type WindowId, type WindowRef } from "./kinds";
import type { LayoutMode, PlacementRoom } from "./modes";
import type { CanvasPlacement, DockPlacement, Placement, Rect } from "./placement";

export type LadderWindows = { hidden: WindowList; shown: WindowList };
export type LadderRateChange = { show: boolean; windows: LadderWindows; mode: LayoutMode; room: PlacementRoom };
export type DockMemory = ReadonlyMap<string, DockPlacement>;
export type ShiftedPlacement = { placement: Placement; remembered: readonly [string, DockPlacement] | null };

const ladderWindows = (windows: readonly WindowRef[]): readonly WindowRef[] => windows.filter(({ kind }) => isLadderKind(kind));

const widthChange = (show: boolean): number => (show ? LADDER_RATE_WIDTH : -LADDER_RATE_WIDTH);

function widened(stored: Rect, drawn: Rect, window: WindowRef, change: number, area: Area): Rect {
  const w = Math.max(minWindowSize(window.kind, window.rateHidden).w, drawn.w + change);
  return { ...stored, x: drawn.x / area.w, w: w / area.w };
}

function shiftCanvas(canvas: CanvasPlacement, { show, windows, room }: LadderRateChange): CanvasPlacement {
  const drawn = rectsForArea(canvas, show ? windows.hidden : windows.shown, room.canvas);
  const moved = ladderWindows(show ? windows.shown : windows.hidden).flatMap((window): [WindowId, Rect][] => {
    const stored = canvas.rects[window.id];
    const box = drawn[window.id];
    return stored && box ? [[window.id, widened(stored, box, window, widthChange(show), room.canvas)]] : [];
  });
  return moved.length === 0 ? canvas : { ...canvas, rects: { ...canvas.rects, ...Object.fromEntries(moved) } };
}

function shiftFloats(dock: DockPlacement, { show, windows, room }: LadderRateChange): DockPlacement["floats"] {
  const area = workArea(room.dock.area.w, room.dock.area.h);
  const ladders = new Map(ladderWindows(show ? windows.shown : windows.hidden).map((window) => [window.id, window]));
  if (!area || !dock.floats.some(({ window }) => ladders.has(window))) return dock.floats;
  const drawn = floatRects(dock, show ? windows.hidden : windows.shown, area);
  return dock.floats.map((float) => {
    const window = ladders.get(float.window);
    const box = drawn[float.window];
    return window && box ? { ...float, rect: widened(float.rect, box, window, widthChange(show), area) } : float;
  });
}

function shiftDock(dock: DockPlacement, change: LadderRateChange, memory: DockMemory): DockPlacement {
  const { show, windows, room } = change;
  const remembered = memory.get(splitShape(dock.root));
  const columns = remembered
    ? carryRatios(dock, dock, remembered)
    : shiftColumns(dock, {
        targets: new Set(ladderWindows(windows.shown).map(({ id }) => id)),
        change: widthChange(show),
        before: { ...room.dock, windows: show ? windows.hidden : windows.shown },
        after: { ...room.dock, windows: show ? windows.shown : windows.hidden },
      });
  const floats = shiftFloats(dock, change);
  return columns === dock && floats === dock.floats ? dock : { root: columns.root, floats };
}

export function shiftForLadderRate(placement: Placement, change: LadderRateChange, memory: DockMemory): ShiftedPlacement {
  if (ladderWindows(change.windows.shown).length === 0) return { placement, remembered: null };
  const before = placement.dock || change.mode === "dock" ? fitDock(placement.dock, change.windows.shown) : null;
  const after = before && shiftDock(before, change, memory);
  const dock = after === before ? placement.dock : after;
  const canvas = placement.canvas && shiftCanvas(placement.canvas, change);
  return {
    placement: dock === placement.dock && canvas === placement.canvas ? placement : { ...placement, dock, canvas },
    remembered: before && after && [splitShape(after.root), before],
  };
}
