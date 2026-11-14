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

  test("9px 떨어지면 달라붙지 않는다", () => {
    expect(moveRect(moving, { x: -91, y: 0 }, [], AREA)).toEqual({ rect: { ...moving, x: 9 }, guides: { x: null, y: null } });
    expect(moveRect(moving, { x: 235, y: 0 }, [other], AREA)).toEqual({ rect: { ...moving, x: 335 }, guides: { x: null, y: null } });
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

  test("위쪽 변은 작업 영역 위로 나가지 않는다", () => {
    const result = resizeRect(rect, "n", { x: 0, y: -500 }, min, [], AREA);
    expect(result.rect).toEqual({ ...rect, y: 0, h: 300 });
    expectHeadInArea(result.rect, AREA);
  });
});
