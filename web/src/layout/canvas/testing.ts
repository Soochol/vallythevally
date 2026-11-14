import { assert, expect } from "vitest";
import { WINDOW_HEAD_HEIGHT, windowId, type WindowKind, type WindowRef } from "../kinds";
import type { CanvasPlacement, Rect } from "../placement";
import { rectsForArea } from "./arrange";
import { HEAD_GRIP, workArea, type Area } from "./geometry";

export function area(w: number, h: number): Area {
  const made = workArea(w, h);
  assert(made, `${w}×${h}는 작업 영역이 될 수 없다`);
  return made;
}

export const AREA = area(1256, 616);

export const win = (id: string, kind: WindowKind): WindowRef => ({ id: windowId(id), kind });

export const WINDOWS: readonly WindowRef[] = [win("c1", "chart"), win("c2", "chart"), win("w", "watchlist"), win("s", "screener"), win("o", "objects")];

export function expectHeadInArea(rect: Rect, area: Area) {
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeLessThanOrEqual(Math.max(0, area.h - WINDOW_HEAD_HEIGHT));
  const visible = Math.min(rect.x + rect.w, area.w) - Math.max(rect.x, 0);
  expect(visible).toBeGreaterThanOrEqual(Math.min(HEAD_GRIP, area.w) - 1e-9);
}

export function expectInside(rect: Rect, area: Area) {
  expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
  expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
  expect(rect.x + rect.w).toBeLessThanOrEqual(area.w + 1e-9);
  expect(rect.y + rect.h).toBeLessThanOrEqual(area.h + 1e-9);
}

export function expectPlacementInvariants(placement: CanvasPlacement, windows: readonly WindowRef[], area: Area) {
  const ids = windows.map(({ id }) => id);
  expect(Object.keys(placement.rects).sort()).toEqual([...ids].sort());
  expect([...placement.order].sort()).toEqual([...ids].sort());
  for (const rect of Object.values(placement.rects)) {
    for (const value of [rect.x, rect.y, rect.w, rect.h]) expect(Number.isFinite(value)).toBe(true);
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
  }
  const drawn = rectsForArea(placement, windows, area);
  expect(Object.keys(drawn).sort()).toEqual([...ids].sort());
  Object.values(drawn).forEach((rect) => expectHeadInArea(rect, area));
}

export function expectRectClose(actual: Rect | undefined, expected: Partial<Rect>) {
  assert.isDefined(actual);
  for (const [key, value] of Object.entries(expected) as [keyof Rect, number][]) expect(actual[key]).toBeCloseTo(value, 6);
}
