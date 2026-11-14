import { describe, expect, test } from "vitest";
import { WINDOW_HEAD_HEIGHT } from "../kinds";
import { minWindowSize } from "./geometry";
import { moveRect, resizeRect } from "./snap";
import { AREA, expectHeadInArea } from "./testing";

const other = { x: 600, y: 100, w: 300, h: 200 };
const moving = { x: 100, y: 400, w: 250, h: 150 };

describe("옮기기", () => {
  test("작업 영역 가장자리에 달라붙고 안내선을 돌려준다", () => {
    expect(moveRect(moving, { x: -95, y: 0 }, [], AREA)).toEqual({ rect: { ...moving, x: 0 }, guides: { x: 0, y: null } });
    expect(moveRect(moving, { x: 0, y: 63 }, [], AREA)).toEqual({ rect: { ...moving, y: 466 }, guides: { x: null, y: 616 } });
    expect(moveRect(moving, { x: 901, y: -396 }, [], AREA)).toEqual({ rect: { ...moving, x: 1006, y: 0 }, guides: { x: 1256, y: 0 } });
  });

  test("다른 창의 가장자리에 맞닿는다", () => {
    expect(moveRect(moving, { x: 249, y: 0 }, [other], AREA)).toEqual({ rect: { ...moving, x: 350 }, guides: { x: 600, y: null } });
    expect(moveRect(moving, { x: 0, y: -103 }, [other], AREA)).toEqual({ rect: { ...moving, y: 300 }, guides: { x: null, y: 300 } });
  });

  test("다른 창의 가장자리에서 6px 띄운다", () => {
    expect(moveRect(moving, { x: 243, y: 0 }, [other], AREA)).toEqual({ rect: { ...moving, x: 344 }, guides: { x: 594, y: null } });
    expect(moveRect(moving, { x: 0, y: -96 }, [other], AREA)).toEqual({ rect: { ...moving, y: 306 }, guides: { x: null, y: 306 } });
  });

  test("다른 창과 같은 줄에 나란히 맞춘다", () => {
    expect(moveRect(moving, { x: 503, y: 0 }, [other], AREA).rect.x).toBe(600);
    expect(moveRect(moving, { x: 553, y: 0 }, [other], AREA)).toEqual({ rect: { ...moving, x: 650 }, guides: { x: 900, y: null } });
    expect(moveRect(moving, { x: 0, y: -297 }, [other], AREA)).toEqual({ rect: { ...moving, y: 100 }, guides: { x: null, y: 100 } });
    expect(moveRect(moving, { x: 0, y: -253 }, [other], AREA)).toEqual({ rect: { ...moving, y: 150 }, guides: { x: null, y: 300 } });
  });

  test("가로와 세로는 따로 달라붙는다", () => {
    expect(moveRect(moving, { x: 249, y: -296 }, [other], AREA)).toEqual({ rect: { ...moving, x: 350, y: 100 }, guides: { x: 600, y: 100 } });
  });

  test("정확히 8px 떨어지면 달라붙는다", () => {
    expect(moveRect(moving, { x: -92, y: 0 }, [], AREA)).toEqual({ rect: { ...moving, x: 0 }, guides: { x: 0, y: null } });
  });

  test("왼쪽과 오른쪽 후보 가운데 더 가까운 쪽에 달라붙는다", () => {
    const right = { x: 600, y: 100, w: 300, h: 200 };
    const near = { x: 357, y: 470, w: 100, h: 100 };
    expect(moveRect({ x: 100, y: 400, w: 250, h: 150 }, { x: 8, y: 0 }, [{ ...right, x: 101 }, near], AREA)).toEqual({
      rect: { x: 107, y: 400, w: 250, h: 150 },
      guides: { x: 357, y: null },
    });
  });

  test("9px 떨어지면 달라붙지 않는다", () => {
    expect(moveRect(moving, { x: -91, y: 0 }, [], AREA)).toEqual({ rect: { ...moving, x: 9 }, guides: { x: null, y: null } });
    expect(moveRect(moving, { x: 235, y: 0 }, [other], AREA)).toEqual({ rect: { ...moving, x: 335 }, guides: { x: null, y: null } });
  });

  test("창 머리 규칙에 걸리는 후보를 건너뛰고 8px 안의 다른 후보에 달라붙는다", () => {
    const low = { x: 100, y: 380, w: 300, h: 200 };
    expect(moveRect({ x: 600, y: 100, w: 300, h: 200 }, { x: 0, y: 485 }, [low], AREA)).toEqual({ rect: { x: 600, y: 580, w: 300, h: 200 }, guides: { x: null, y: 580 } });
    const wide = { x: 800, y: 300, w: 372, h: 200 };
    expect(moveRect({ x: 600, y: 0, w: 300, h: 200 }, { x: 579, y: 0 }, [wide], AREA)).toEqual({ rect: { x: 1172, y: 0, w: 300, h: 200 }, guides: { x: 1172, y: 0 } });
  });

  test("창 머리는 언제나 작업 영역 안에 남는다", () => {
    const left = moveRect(moving, { x: -5000, y: -5000 }, [other], AREA);
    expect(left.rect).toEqual({ ...moving, x: 80 - moving.w, y: 0 });
    expect(left.guides.x).toBeNull();
    const right = moveRect(moving, { x: 5000, y: 5000 }, [other], AREA);
    expect(right.rect).toEqual({ ...moving, x: AREA.w - 80, y: AREA.h - WINDOW_HEAD_HEIGHT });
    expect(right.guides).toEqual({ x: null, y: null });
    [left.rect, right.rect].forEach((rect) => expectHeadInArea(rect, AREA));
  });
});

describe("크기 바꾸기", () => {
  const rect = { x: 100, y: 100, w: 300, h: 200 };
  const min = minWindowSize("chart");

  test("모서리와 변을 끌어 크기를 바꾼다", () => {
    expect(resizeRect(rect, "se", { x: 50, y: 30 }, min, [], AREA)).toEqual({ rect: { ...rect, w: 350, h: 230 }, guides: { x: null, y: null }, atMinimum: false });
    expect(resizeRect(rect, "w", { x: -40, y: 99 }, min, [], AREA)).toEqual({ rect: { ...rect, x: 60, w: 340 }, guides: { x: null, y: null }, atMinimum: false });
    expect(resizeRect(rect, "n", { x: 99, y: -50 }, min, [], AREA)).toEqual({ rect: { ...rect, y: 50, h: 250 }, guides: { x: null, y: null }, atMinimum: false });
    expect(resizeRect(rect, "ne", { x: 20, y: -20 }, min, [], AREA).rect).toEqual({ x: 100, y: 80, w: 320, h: 220 });
  });

  test("최소 크기에서 멈추고 멈췄다고 알린다", () => {
    expect(resizeRect(rect, "nw", { x: 1000, y: 1000 }, min, [], AREA)).toEqual({
      rect: { x: 400 - min.w, y: 300 - min.h, w: min.w, h: min.h },
      guides: { x: null, y: null },
      atMinimum: true,
    });
    expect(resizeRect(rect, "se", { x: -1000, y: 0 }, min, [], AREA)).toMatchObject({ rect: { ...rect, w: min.w }, atMinimum: true });
    expect(resizeRect(rect, "s", { x: 0, y: -6 }, min, [], AREA).atMinimum).toBe(false);
  });

  test("가장자리와 다른 창에 달라붙는다", () => {
    expect(resizeRect(rect, "se", { x: 852, y: 311 }, min, [], AREA)).toEqual({ rect: { ...rect, w: 1156, h: 516 }, guides: { x: 1256, y: 616 }, atMinimum: false });
    expect(resizeRect(rect, "e", { x: 195, y: 0 }, min, [other], AREA)).toEqual({ rect: { ...rect, w: 494 }, guides: { x: 594, y: null }, atMinimum: false });
    expect(resizeRect(rect, "s", { x: 0, y: 3 }, min, [other], AREA)).toEqual({ rect: { ...rect, h: 200 }, guides: { x: null, y: 300 }, atMinimum: false });
    expect(resizeRect(rect, "e", { x: 185, y: 0 }, min, [other], AREA).guides).toEqual({ x: null, y: null });
  });

  test("최소 크기 아래의 후보는 건너뛰고 최소 크기에 닿지 않았으면 멈췄다고 알리지 않는다", () => {
    const wide = { x: 100, y: 100, w: 400, h: 300 };
    const others = [{ x: 378, y: 450, w: 300, h: 100 }, { x: 396, y: 450, w: 300, h: 100 }];
    expect(resizeRect(wide, "e", { x: -117, y: 0 }, { w: 280, h: 194 }, others, AREA)).toEqual({ rect: { ...wide, w: 290 }, guides: { x: 390, y: null }, atMinimum: false });
  });

  test("왼쪽 변과 위쪽 변도 다른 창에 달라붙는다", () => {
    const left = { x: 0, y: 0, w: 94, h: 90 };
    expect(resizeRect(rect, "w", { x: -3, y: 0 }, min, [left], AREA)).toEqual({ rect: { ...rect, x: 94, w: 306 }, guides: { x: 94, y: null }, atMinimum: false });
    expect(resizeRect(rect, "nw", { x: 3, y: -5 }, min, [left], AREA)).toEqual({ rect: { x: 100, y: 96, w: 300, h: 204 }, guides: { x: 100, y: 96 }, atMinimum: false });
  });

  test("최소 크기를 넘어 끌면 그 너머의 후보에 달라붙지 않고 안내선도 없다", () => {
    const beyond = [{ x: 375, y: 450, w: 10, h: 10 }];
    expect(resizeRect(rect, "e", { x: -26, y: 0 }, min, beyond, AREA)).toEqual({ rect: { ...rect, w: min.w }, guides: { x: null, y: null }, atMinimum: true });
  });

  test("끌어서 작업 영역 밖으로 키우지 않는다", () => {
    expect(resizeRect(rect, "e", { x: 5000, y: 0 }, min, [], AREA).rect.w).toBe(1156);
    expect(resizeRect(rect, "s", { x: 0, y: 5000 }, min, [], AREA).rect.h).toBe(516);
  });

  test("이미 최소 크기보다 작은 창은 왼쪽 위를 기준으로 최소 크기로 키운 뒤 크기를 바꾼다", () => {
    const small = { x: 50, y: 100, w: 200, h: 100 };
    const grown = { ...small, w: min.w, h: min.h };
    for (const handle of ["w", "e", "n", "s"] as const) {
      expect(resizeRect(small, handle, { x: 0, y: 0 }, min, [], AREA)).toEqual({ rect: grown, guides: { x: null, y: null }, atMinimum: false });
    }
    expect(resizeRect(small, "e", { x: 10, y: 0 }, min, [], AREA).rect).toEqual({ ...grown, w: min.w + 10 });
  });

  test("오른쪽 가장자리의 좁은 창은 키운 뒤 창 머리가 영역 안에 오게 옮기고 그 자리에서 크기를 바꾼다", () => {
    const narrow = { x: 1200, y: 100, w: 50, h: 200 };
    expect(resizeRect(narrow, "s", { x: 0, y: 20 }, min, [], AREA).rect).toEqual({ x: 1176, y: 100, w: 280, h: 220 });
    const result = resizeRect(narrow, "e", { x: 3, y: 0 }, min, [{ x: 1176, y: 300, w: 304, h: 200 }], AREA);
    expect(result).toEqual({ rect: { x: 1176, y: 100, w: 280, h: 200 }, guides: { x: null, y: null }, atMinimum: false });
  });

  test("위쪽 변은 작업 영역 위로 나가지 않는다", () => {
    const result = resizeRect(rect, "n", { x: 0, y: -500 }, min, [], AREA);
    expect(result.rect).toEqual({ ...rect, y: 0, h: 300 });
    expectHeadInArea(result.rect, AREA);
  });
});
