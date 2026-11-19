import { describe, expect, it } from "vitest";
import { layoutSectorMap, sectorFill } from "./sectorMap";

const SECTORS = [
  { code: "a", tradeValueEok: 600 },
  { code: "b", tradeValueEok: 300 },
  { code: "c", tradeValueEok: 100 },
  { code: "z", tradeValueEok: 0 },
];

describe("layoutSectorMap", () => {
  const tiles = layoutSectorMap(SECTORS, 100, 60);
  const area = (code: string) => {
    const tile = tiles.find((t) => t.code === code)!;
    return tile.w * tile.h;
  };

  it("거래대금이 없는 업종은 칸이 없다", () => {
    expect(tiles.map((t) => t.code).toSorted()).toEqual(["a", "b", "c"]);
  });
  it("칸 넓이는 거래대금에 비례하고 전체를 채운다", () => {
    expect(area("a") / area("b")).toBeCloseTo(2, 5);
    expect(area("b") / area("c")).toBeCloseTo(3, 5);
    expect(tiles.reduce((sum, t) => sum + t.w * t.h, 0)).toBeCloseTo(6000, 5);
  });
  it("칸이 상자 밖으로 나가지 않는다", () => {
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-9);
      expect(t.y).toBeGreaterThanOrEqual(-1e-9);
      expect(t.x + t.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(t.y + t.h).toBeLessThanOrEqual(60 + 1e-9);
    }
  });
  it("빈 입력이면 빈 배열이다", () => {
    expect(layoutSectorMap([], 100, 60)).toEqual([]);
  });
});

describe("sectorFill", () => {
  it("부호에 따라 색을 고르고 ±3%에서 포화한다", () => {
    expect(sectorFill(0)).toBe("var(--raised)");
    expect(sectorFill(1)).toContain("var(--up)");
    expect(sectorFill(-1)).toContain("var(--down)");
    expect(sectorFill(3)).toBe(sectorFill(9));
  });
});
