import { describe, expect, it } from "vitest";
import { reachesDivider } from "./dividerReach";

const rect = { x: 100, y: 10, w: 6, h: 200 };

describe("reachesDivider", () => {
  it("틈 밖 양쪽 3px 띠에 닿는다", () => {
    expect(reachesDivider({ x: 97, y: 50 }, rect, true)).toBe(true);
    expect(reachesDivider({ x: 108, y: 50 }, rect, true)).toBe(true);
  });
  it("틈 자체와 3px 너머와 길이 밖은 닿지 않는다", () => {
    expect(reachesDivider({ x: 102, y: 50 }, rect, true)).toBe(false);
    expect(reachesDivider({ x: 96, y: 50 }, rect, true)).toBe(false);
    expect(reachesDivider({ x: 109, y: 50 }, rect, true)).toBe(false);
    expect(reachesDivider({ x: 97, y: 5 }, rect, true)).toBe(false);
  });
  it("가로 경계는 위아래 띠에 닿는다", () => {
    const flat = { x: 10, y: 100, w: 200, h: 6 };
    expect(reachesDivider({ x: 50, y: 98 }, flat, false)).toBe(true);
    expect(reachesDivider({ x: 50, y: 109 }, flat, false)).toBe(false);
  });
});
