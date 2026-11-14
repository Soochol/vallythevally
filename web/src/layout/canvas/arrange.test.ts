import { describe, expect, test } from "vitest";
import { windowId } from "../kinds";
import type { CanvasPlacement, Rect } from "../placement";
import { bringToFront, fitCanvas, placeNewWindow, rectsForArea, tidyWindows } from "./arrange";
import { countOverlaps, minWindowSize, toPx, toRatio, type Area } from "./geometry";
import { area, AREA, expectHeadInArea, expectInside, expectRectClose, win, WINDOWS } from "./testing";

const id = windowId;
const ratio = (rect: Rect) => toRatio(rect, AREA);

describe("새 창의 자리", () => {
  test("종류별 기본 크기로 작업 영역 가운데에 놓는다", () => {
    expect(placeNewWindow("chart", [], AREA)).toEqual({ x: 308, y: 98, w: 640, h: 420 });
    for (const kind of ["watchlist", "screener", "objects", "indicators"] as const) expect(placeNewWindow(kind, [], AREA)).toEqual({ x: 468, y: 108, w: 320, h: 400 });
  });

  test("같은 자리에 창이 있으면 오른쪽 아래로 24px씩 비켜 놓는다", () => {
    const center = { x: 308, y: 98, w: 640, h: 420 };
    expect(placeNewWindow("chart", [center], AREA)).toEqual({ ...center, x: 332, y: 122 });
    expect(placeNewWindow("chart", [{ ...center, x: 332, y: 122 }, center], AREA)).toEqual({ ...center, x: 356, y: 146 });
    expect(placeNewWindow("chart", [{ ...center, x: 0 }], AREA)).toEqual(center);
    expect(placeNewWindow("chart", [{ ...center, y: 0 }], AREA)).toEqual(center);
  });

  test("좁은 영역에서는 영역에 맞게 줄이되 최소 크기 아래로는 줄이지 않는다", () => {
    expect(placeNewWindow("chart", [], area(500, 300))).toEqual({ x: 0, y: 0, w: 500, h: 300 });
    const tiny = area(200, 150);
    const rect = placeNewWindow("chart", [], tiny);
    expect(rect).toMatchObject({ w: minWindowSize("chart").w, h: minWindowSize("chart").h, y: 0 });
    expectHeadInArea(rect, tiny);
  });
});

describe("창 목록에 맞추기", () => {
  const two = [win("c1", "chart"), win("w", "watchlist")];
  const stored: CanvasPlacement = {
    rects: { [id("c1")]: ratio({ x: 0, y: 0, w: 900, h: 616 }), [id("w")]: ratio({ x: 906, y: 0, w: 350, h: 616 }) },
    order: [id("c1"), id("w")],
  };

  test("배치가 없으면 모든 창을 가지런히 놓는다", () => {
    const fitted = fitCanvas(null, WINDOWS, AREA);
    const { rects } = tidyWindows(WINDOWS, AREA);
    expect(fitted.order).toEqual(WINDOWS.map((window) => window.id));
    for (const window of WINDOWS) {
      expectRectClose(toPx(fitted.rects[window.id]!, AREA), rects[window.id]!);
    }
  });

  test("창 목록에 없는 창의 사각형과 순서 항목을 지운다", () => {
    const fitted = fitCanvas(stored, [win("c1", "chart")], AREA);
    expect(fitted).toEqual({ rects: { [id("c1")]: stored.rects[id("c1")] }, order: [id("c1")] });
  });

  test("배치에 없는 창은 새 창의 자리에 놓고 맨 앞에 둔다", () => {
    const fitted = fitCanvas(stored, [...two, win("s", "screener")], AREA);
    expect(fitted.order).toEqual([id("c1"), id("w"), id("s")]);
    expectRectClose(toPx(fitted.rects[id("s")]!, AREA), { x: 468, y: 108, w: 320, h: 400 });
    expect(fitted.rects[id("c1")]).toBe(stored.rects[id("c1")]);
  });

  test("새 창끼리도 같은 자리를 피한다", () => {
    const fitted = fitCanvas(stored, [...two, win("c2", "chart"), win("c3", "chart")], AREA);
    expectRectClose(toPx(fitted.rects[id("c2")]!, AREA), { x: 308, y: 98 });
    expectRectClose(toPx(fitted.rects[id("c3")]!, AREA), { x: 332, y: 122 });
  });

  test("순서에서 빠졌거나 겹친 항목과 크기가 0인 사각형을 바로잡는다", () => {
    const broken: CanvasPlacement = { rects: { ...stored.rects, [id("w")]: { x: 0.1, y: 0.1, w: 0, h: 0.5 } }, order: [id("c1"), id("c1")] };
    const fitted = fitCanvas(broken, two, AREA);
    expect(fitted.order).toEqual([id("c1"), id("w")]);
    expectRectClose(toPx(fitted.rects[id("w")]!, AREA), { x: 468, y: 108, w: 320, h: 400 });
  });

  test("그릴 수 없는 사각형은 새 창의 자리로 다시 놓는다", () => {
    const huge: CanvasPlacement = { ...stored, rects: { ...stored.rects, [id("w")]: { x: 0.1, y: 0.1, w: 1e306, h: 0.5 } } };
    expectRectClose(toPx(fitCanvas(huge, two, AREA).rects[id("w")]!, AREA), { x: 468, y: 108, w: 320, h: 400 });
  });

  test("작업 영역 밖에 있는 사각형은 저장값을 그대로 두고 창 머리가 영역 안에 오게 그린다", () => {
    const outside: CanvasPlacement = { ...stored, rects: { ...stored.rects, [id("w")]: { x: 1.2, y: -0.3, w: 0.2, h: 0.5 } } };
    expect(fitCanvas(outside, two, AREA)).toBe(outside);
    expectHeadInArea(rectsForArea(outside, two, AREA)[id("w")]!, AREA);
  });

  test("작업 영역만 바뀌면 저장값을 고치지 않는다", () => {
    const placement = fitCanvas(null, WINDOWS, area(1920, 1000));
    expect(fitCanvas(placement, WINDOWS, area(600, 400))).toBe(placement);
  });

  test("창 목록에 없는 창을 가리키는 순서 항목만 있어도 지운다", () => {
    expect(fitCanvas({ ...stored, order: [id("c1"), id("gone"), id("w")] }, two, AREA)).toEqual(stored);
  });

  test("사각형은 있는데 순서에서 빠진 창은 사각형을 두고 맨 앞에 둔다", () => {
    const fitted = fitCanvas({ ...stored, order: [id("w")] }, two, AREA);
    expect(fitted).toEqual({ rects: stored.rects, order: [id("w"), id("c1")] });
  });

  test("맞출 것이 없으면 같은 참조를 돌려준다", () => {
    expect(fitCanvas(stored, two, AREA)).toBe(stored);
    expect(fitCanvas(stored, [...two].reverse(), AREA)).toBe(stored);
  });
});

describe("맨 앞으로", () => {
  const placement: CanvasPlacement = { rects: {}, order: [id("a"), id("b"), id("c")] };

  test("창 하나를 순서의 맨 뒤로 옮긴다", () => {
    expect(bringToFront(placement, id("a")).order).toEqual([id("b"), id("c"), id("a")]);
    expect(placement.order).toEqual([id("a"), id("b"), id("c")]);
  });

  test("이미 맨 앞이거나 순서에 없는 창이면 같은 참조를 돌려준다", () => {
    expect(bringToFront(placement, id("c"))).toBe(placement);
    expect(bringToFront(placement, id("gone"))).toBe(placement);
  });
});

describe("가지런히", () => {
  test("차트는 왼쪽에 쌓고 나머지는 오른쪽 열에 놓아 겹침을 푼다", () => {
    const { rects, undersized } = tidyWindows(WINDOWS, AREA);
    expect(countOverlaps(Object.values(rects))).toBe(0);
    Object.values(rects).forEach((rect) => expectInside(rect, AREA));
    expect(undersized).toBe(0);
    expect(rects[id("c1")]).toEqual({ x: 0, y: 0, w: 644, h: 305 });
    expect(rects[id("c2")]).toEqual({ x: 0, y: 311, w: 644, h: 305 });
    expect(rects[id("w")]).toEqual({ x: 650, y: 0, w: 300, h: 275 });
    expect(rects[id("s")]).toEqual({ x: 650, y: 281, w: 300, h: 335 });
    expect(rects[id("o")]).toEqual({ x: 956, y: 0, w: 300, h: 616 });
  });

  test("높이가 넉넉하면 오른쪽 열 하나에 모두 놓고 모자라면 열을 늘린다", () => {
    const sideColumns = (size: Area) => {
      const { rects } = tidyWindows(WINDOWS, size);
      return new Set(["w", "s", "o"].map((key) => rects[id(key)]!.x)).size;
    };
    expect(sideColumns(area(1256, 800))).toBe(1);
    expect(sideColumns(AREA)).toBe(2);
    expect(sideColumns(area(1256, 300))).toBe(3);
  });

  test("열은 창 사이 간격까지 넣어 최소 높이를 지킬 수 있을 때만 함께 쓴다", () => {
    const charts = [win("c1", "chart"), win("c2", "chart")];
    expect(tidyWindows(charts, area(1256, 394)).rects[id("c2")]).toMatchObject({ x: 0, y: 200 });
    expect(tidyWindows(charts, area(1256, 393)).rects[id("c2")]).toMatchObject({ y: 0 });
  });

  test("높이만 모자라도 최소 크기를 못 지킨 창으로 센다", () => {
    expect(tidyWindows([win("c1", "chart")], area(1256, 150)).undersized).toBe(1);
  });

  test("최소 크기를 못 지킨 창의 수를 알린다", () => {
    const short = area(1256, 300);
    const { rects, undersized } = tidyWindows(WINDOWS, short);
    expect(undersized).toBe(3);
    expect(countOverlaps(Object.values(rects))).toBe(0);
    Object.values(rects).forEach((rect) => expectInside(rect, short));
  });
});

describe("작업 영역 크기가 바뀔 때", () => {
  test("영역이 절반으로 줄면 최소 크기보다 작아진 창을 최소 크기로 그리고 저장값은 그대로 둔다", () => {
    const placement = fitCanvas(null, WINDOWS, AREA);
    const saved = structuredClone(placement);
    const half = area(AREA.w / 2, AREA.h / 2);
    const drawn = rectsForArea(placement, WINDOWS, half);
    for (const window of WINDOWS) {
      const rect = drawn[window.id]!;
      const min = minWindowSize(window.kind);
      expect(rect.w).toBeGreaterThanOrEqual(min.w);
      expect(rect.h).toBeGreaterThanOrEqual(min.h);
      expectInside(rect, half);
    }
    expectRectClose(drawn[id("c1")], { x: 0, y: 0, w: 322, h: minWindowSize("chart").h });
    expect(placement).toEqual(saved);
  });

  test("최소 크기를 넘는 창은 비율대로 늘고 준다", () => {
    const placement = fitCanvas(null, WINDOWS, AREA);
    const double = area(AREA.w * 2, AREA.h * 2);
    expectRectClose(rectsForArea(placement, WINDOWS, double)[id("o")], { x: 1912, y: 0, w: 600, h: 1232 });
  });
});
