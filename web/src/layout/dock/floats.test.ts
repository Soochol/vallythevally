import { expect, test } from "vitest";
import { toPx, workArea } from "../canvas/geometry";
import { windowId } from "../kinds";
import { defaultDock, type WindowList } from "./fit";
import { attachFloat, canDetach, detachedRect, detachWindow, floatRects, frontFloat, moveFloat, reconcileOrigins } from "./floats";
import { groupOfWindow, listGroups, putTab } from "./tree";

const a = windowId("a"), b = windowId("b"), c = windowId("c"), d = windowId("d");
const windows: WindowList = [{ id: a, kind: "chart" }, { id: b, kind: "chart" }, { id: c, kind: "screener" }, { id: d, kind: "objects" }];
const rect = { x: .2, y: .1, w: .3, h: .4 };
const all = (dock: ReturnType<typeof defaultDock>) => [...listGroups(dock.root).flatMap((group) => group.tabs), ...dock.floats.map((float) => float.window)];

test("탭을 띄우고 마지막 탭의 묶음을 접으며 마지막 도킹 창을 남긴다", () => {
  const dock = defaultDock(windows);
  const first = detachWindow(dock, a, rect);
  expect(groupOfWindow(first.root, a)).toBeNull();
  expect(listGroups(first.root).map((group) => group.id)).not.toContain("g1");
  expect(first.floats).toEqual([{ window: a, rect }]);
  const next = detachWindow(detachWindow(first, c, rect), b, rect);
  expect(canDetach(next, d)).toBe(false);
  expect(detachWindow(next, d, rect)).toBe(next);
  expect(detachWindow(first, a, rect)).toBe(first);
  expect(all(next).sort()).toEqual([a, b, c, d].sort());
});

test("살아 있는 원래 묶음에 붙이고 없으면 기본 자리로 넣어 창 하나가 한 곳에만 있다", () => {
  const dock = defaultDock(windows);
  const detached = detachWindow(dock, c, rect);
  const origin = groupOfWindow(dock.root, c)!.id;
  const attached = attachFloat(detached, c, origin, windows);
  expect(groupOfWindow(attached.root, c)?.id).toBe(origin);
  expect(groupOfWindow(attached.root, c)?.active).toBe(c);
  expect(attached.floats).toEqual([]);
  expect(all(attached).sort()).toEqual([a, b, c, d].sort());
  expect(groupOfWindow(attachFloat(detached, c, undefined, windows).root, c)?.tabs).toEqual([d, c]);
  expect(attachFloat(attached, c, origin, windows)).toBe(attached);
});

test("앞뒤와 비율은 floats 차례만 바꾸고 같은 이동은 원래 배치를 돌려준다", () => {
  const dock = detachWindow(detachWindow(defaultDock(windows), c, rect), b, rect);
  const front = frontFloat(dock, c);
  expect(front.floats.map((float) => float.window)).toEqual([b, c]);
  expect(frontFloat(front, c)).toBe(front);
  expect(moveFloat(front, c, rect)).toBe(front);
  const moved = moveFloat(front, c, { ...rect, x: .4 });
  expect(moved.floats.at(-1)?.rect.x).toBe(.4);
  expect(moved.root).toBe(dock.root);
});

test("원래 묶음 기억은 묶음이 사라지면 지우고 같은 id가 다시 생겨도 돌아오지 않는다", () => {
  const dock = defaultDock(windows);
  const detached = detachWindow(dock, c, rect);
  const origins = reconcileOrigins(dock, detached, new Map());
  expect(origins.get(c)).toBe("g3");
  const gone = putTab(detached, d, "g1");
  const forgotten = reconcileOrigins(detached, gone, origins);
  expect(forgotten.has(c)).toBe(false);
  const reused = { ...gone, root: { kind: "group" as const, id: "g3", tabs: [a, b, d], active: a } };
  expect(reconcileOrigins(gone, reused, forgotten).has(c)).toBe(false);
  expect(reconcileOrigins(detached, attachFloat(detached, c, "g3", windows), origins).size).toBe(0);
});

test("새 창 크기와 비율을 쓰고 작은 작업 영역에서도 머리와 최소 크기를 지킨다", () => {
  const dock = defaultDock(windows);
  const area = workArea(1400, 800)!;
  const space = { area, gap: 6, windows };
  const ratio = detachedRect(dock, c, space, area, { x: 400, y: 100 })!;
  expect(toPx(ratio, area)).toEqual({ x: 320, y: 86, w: 320, h: 400 });
  const floated = detachWindow(dock, c, ratio);
  const small = workArea(300, 200)!;
  const box = floatRects(floated, windows, small)[c]!;
  expect(box.w).toBeGreaterThanOrEqual(240);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + 34).toBeLessThanOrEqual(small.h);
});
