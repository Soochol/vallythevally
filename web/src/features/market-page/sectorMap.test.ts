import { describe, expect, it } from "vitest";
import { layoutSectorMap, sectorTileLabel } from "./sectorMap";

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

describe("sectorTileLabel", () => {
  it("작은 칸은 등락률만, 더 작은 칸은 글자가 없다", () => {
    expect(sectorTileLabel(80, 40)).toBe("full");
    expect(sectorTileLabel(55, 40)).toBe("rate");
    expect(sectorTileLabel(80, 33)).toBe("rate");
    expect(sectorTileLabel(39, 40)).toBe("none");
    expect(sectorTileLabel(80, 19)).toBe("none");
  });
});
