import { describe, expect, test } from "vitest";
import { copy, PASTE_SHIFT_BARS, paste, type PasteTarget } from "./clipboard";
import type { DrawingBody } from "./types";

const BAR = 60;
const body = (id: string, z: number, overrides: Partial<DrawingBody> = {}): DrawingBody => ({
  id,
  symbol: "005930",
  tool: "trendline",
  points: [
    { t: 600, price: 100 },
    { t: 1200, price: 110 },
  ],
  text: "메모",
  style: { v: 1, line: { color: "#ff0000", width: 3, dash: "dashed" } },
  locked: true,
  hidden: false,
  periods: ["D"],
  z,
  group: "그룹 1",
  scope: { kind: "symbol" },
  revision: 77,
  ...overrides,
});

const target = (symbol: string): PasteTarget => {
  let n = 0;
  return {
    symbol,
    topZ: 10,
    scope: { kind: "layout", layoutId: "L1" },
    newId: () => `new-${++n}`,
    shiftBars: (t, bars) => (t < 0 ? null : t + bars * BAR),
  };
};

test("잠긴 것도 복사한다. 비어 있으면 복사하지 않는다", () => {
  expect(copy([body("a", 1)], "005930")?.items).toHaveLength(1);
  expect(copy([], "005930")).toBeNull();
});

describe("붙여넣기", () => {
  const clip = copy([body("b", 3), body("a", 1)], "005930");
  if (clip === null) throw new Error("clip");

  test("새 id, 잠금 풂, 그룹 없음, 맨 위 z, 새 드로잉 범위. 스타일·글자·봉 주기는 그대로", () => {
    const { bodies } = paste(clip, target("000660"));
    expect(bodies.map((b) => [b.id, b.z, b.locked, b.group, b.symbol])).toEqual([
      ["new-1", 11, false, null, "000660"],
      ["new-2", 12, false, null, "000660"],
    ]);
    expect(bodies[0]).toMatchObject({ text: "메모", periods: ["D"], style: body("a", 1).style, scope: { kind: "layout", layoutId: "L1" }, revision: 0 });
  });

  test("z 순서를 지킨다", () => {
    const { bodies } = paste(clip, target("005930"));
    expect(bodies.map((b) => b.z)).toEqual([11, 12]);
  });

  test("다른 종목이면 같은 시각·가격", () => {
    const { bodies, clip: after } = paste(clip, target("000660"));
    expect(bodies[0]?.points).toEqual(body("a", 1).points);
    expect(after.pastes).toBe(0);
  });

  test("같은 종목이면 붙일 때마다 5봉씩 더 오른쪽", () => {
    const first = paste(clip, target("005930"));
    expect(first.bodies[0]?.points.map((p) => p.t)).toEqual([600 + PASTE_SHIFT_BARS * BAR, 1200 + PASTE_SHIFT_BARS * BAR]);
    const second = paste(first.clip, target("005930"));
    expect(second.bodies[0]?.points.map((p) => p.t)).toEqual([600 + 2 * PASTE_SHIFT_BARS * BAR, 1200 + 2 * PASTE_SHIFT_BARS * BAR]);
  });

  test("옮길 수 없는 점(첫 봉 앞)이 있으면 그 드로잉은 옮기지 않고 모양을 지킨다", () => {
    const early = copy([body("e", 1, { points: [{ t: -60, price: 1 }, { t: 600, price: 2 }] })], "005930");
    if (early === null) throw new Error("clip");
    expect(paste(early, target("005930")).bodies[0]?.points).toEqual([
      { t: -60, price: 1 },
      { t: 600, price: 2 },
    ]);
  });

  test("원본 클립은 바꾸지 않는다", () => {
    paste(clip, target("005930"));
    expect(clip.pastes).toBe(0);
    expect(clip.items[0]?.id).toBe("a");
  });
});
