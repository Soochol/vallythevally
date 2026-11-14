import type { WindowId, WindowKind, WindowRef } from "../kinds";
import type { CanvasPlacement, Rect } from "../placement";
import { clamp, keepHeadInArea, minWindowSize, toPx, toRatio, WINDOW_GAP, type Area, type Size } from "./geometry";

export const CASCADE_STEP = 24;
export const SIDE_COLUMN_WIDTH = 300;

export const DEFAULT_WINDOW_SIZE: Readonly<Record<WindowKind, Size>> = Object.freeze({
  chart: { w: 640, h: 420 },
  watchlist: { w: 320, h: 400 },
  screener: { w: 320, h: 400 },
  objects: { w: 320, h: 400 },
  indicators: { w: 320, h: 400 },
});

const sameSpot = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

export function placeNewWindow(kind: WindowKind, others: readonly Rect[], area: Area): Rect {
  const min = minWindowSize(kind);
  const wanted = DEFAULT_WINDOW_SIZE[kind];
  const w = Math.max(min.w, Math.min(wanted.w, area.w));
  const h = Math.max(min.h, Math.min(wanted.h, area.h));
  let rect = keepHeadInArea({ x: (area.w - w) / 2, y: (area.h - h) / 2, w, h }, area);
  for (let step = 0; step < others.length && others.some((other) => sameSpot(other, rect)); step++) {
    rect = keepHeadInArea({ ...rect, x: rect.x + CASCADE_STEP, y: rect.y + CASCADE_STEP }, area);
  }
  return rect;
}

type Column = { windows: WindowRef[]; minHeight: number };

function packColumns(windows: readonly WindowRef[], height: number): Column[] {
  const columns: Column[] = [];
  for (const window of windows) {
    const need = minWindowSize(window.kind).h;
    const last = columns.at(-1);
    if (last && last.minHeight + WINDOW_GAP + need <= height) {
      last.windows.push(window);
      last.minHeight += WINDOW_GAP + need;
    } else {
      columns.push({ windows: [window], minHeight: need });
    }
  }
  return columns;
}

function columnWidths(charts: number, sides: number, gap: number, area: Area): { chart: number; side: number } {
  const available = area.w - Math.max(0, charts + sides - 1) * gap;
  if (charts === 0) return { chart: 0, side: available / sides };
  const chartMin = minWindowSize("chart").w;
  const sideTotal = sides * SIDE_COLUMN_WIDTH;
  if (available - sideTotal >= charts * chartMin) return { chart: (available - sideTotal) / charts, side: SIDE_COLUMN_WIDTH };
  const scale = available / (sideTotal + charts * chartMin);
  return { chart: chartMin * scale, side: SIDE_COLUMN_WIDTH * scale };
}

const MIN_SIZE_TOLERANCE = 1e-6;

export function tidyWindows(windows: readonly WindowRef[], area: Area): { rects: Record<WindowId, Rect>; undersized: number } {
  const chartColumns = packColumns(windows.filter((window) => window.kind === "chart"), area.h);
  const sideColumns = packColumns(windows.filter((window) => window.kind !== "chart"), area.h);
  const columns = chartColumns.length + sideColumns.length;
  const gap = Math.min(WINDOW_GAP, area.w / (2 * columns));
  const widths = columnWidths(chartColumns.length, sideColumns.length, gap, area);
  const rects: Record<WindowId, Rect> = {};
  let undersized = 0;
  let x = 0;
  const lay = (column: Column, w: number) => {
    const extra = (area.h - column.minHeight) / column.windows.length;
    let y = 0;
    for (const window of column.windows) {
      const min = minWindowSize(window.kind);
      const h = min.h + extra;
      rects[window.id] = { x, y, w, h };
      if (w < min.w - MIN_SIZE_TOLERANCE || h < min.h - MIN_SIZE_TOLERANCE) undersized++;
      y += h + WINDOW_GAP;
    }
    x += w + gap;
  };
  chartColumns.forEach((column) => lay(column, widths.chart));
  sideColumns.forEach((column) => lay(column, widths.side));
  return { rects, undersized };
}

const drawable = (rect: Rect, area: Area): boolean => {
  const px = toPx(rect, area);
  return [px.x, px.y, px.w, px.h].every(Number.isFinite) && px.w > 0 && px.h > 0;
};

const sameOrder = (a: readonly WindowId[], b: readonly WindowId[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

export function fitCanvas(placement: CanvasPlacement | null, windows: readonly WindowRef[], area: Area): CanvasPlacement {
  if (!placement) {
    const { rects } = tidyWindows(windows, area);
    return {
      rects: Object.fromEntries(Object.entries(rects).map(([id, rect]) => [id, toRatio(rect, area)])),
      order: windows.map(({ id }) => id),
    };
  }
  const listed = new Set(windows.map(({ id }) => id));
  const rects: Record<WindowId, Rect> = {};
  let changed = false;
  for (const [key, rect] of Object.entries(placement.rects) as [WindowId, Rect][]) {
    if (listed.has(key) && drawable(rect, area)) rects[key] = rect;
    else changed = true;
  }
  const order = [...new Set(placement.order)].filter((id) => listed.has(id) && rects[id]);
  for (const { id, kind } of windows) {
    if (order.includes(id)) continue;
    if (!rects[id]) {
      const others = Object.values(rects).map((rect) => toPx(rect, area));
      rects[id] = toRatio(placeNewWindow(kind, others, area), area);
      changed = true;
    }
    order.push(id);
  }
  return changed || !sameOrder(order, placement.order) ? { rects, order } : placement;
}

export function bringToFront(placement: CanvasPlacement, id: WindowId): CanvasPlacement {
  const { order } = placement;
  if (order.at(-1) === id || !order.includes(id)) return placement;
  return { ...placement, order: [...order.filter((other) => other !== id), id] };
}

export function rectsForArea(placement: CanvasPlacement, windows: readonly WindowRef[], area: Area): Record<WindowId, Rect> {
  const drawn: Record<WindowId, Rect> = {};
  for (const { id, kind } of windows) {
    const stored = placement.rects[id];
    if (!stored) continue;
    const px = toPx(stored, area);
    const min = minWindowSize(kind);
    const w = Math.max(px.w, min.w);
    const h = Math.max(px.h, min.h);
    const grown = w === px.w && h === px.h ? px : { x: clamp(px.x, Math.min(px.x, 0), area.w - w), y: clamp(px.y, Math.min(px.y, 0), area.h - h), w, h };
    drawn[id] = keepHeadInArea(grown, area);
  }
  return drawn;
}
