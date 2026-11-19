import { describe, expect, it } from "vitest";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import { cumulativeCurve, filterFunds, issuersOf, NO_FILTER, squarify } from "./etfModel";

const fund = (code: string, name: string, style: EtfFundSummary["style"], issuer: string): EtfFundSummary => ({
  code, name, issuer, style, benchmark: "", holdingsCount: 1, top5WeightBps: 100, effectiveHoldings: 1,
  status: { source: "snapshot", holdingsAsOf: "2026-10-30", lastAttemptAt: null, refreshFailed: false },
});

const FUNDS = [
  fund("091160", "KODEX 반도체", "passive", "삼성자산운용"),
  fund("444200", "SOL 코리아메가테크액티브", "active", "신한자산운용"),
  fund("0222D0", "TIME 미국나스닥100액티브", "active", "타임폴리오자산운용"),
];

describe("filterFunds", () => {
  it("이름과 코드로 찾고 대소문자를 가리지 않는다", () => {
    expect(filterFunds(FUNDS, { ...NO_FILTER, query: "반도체" }).map((f) => f.code)).toEqual(["091160"]);
    expect(filterFunds(FUNDS, { ...NO_FILTER, query: "0222d0" }).map((f) => f.code)).toEqual(["0222D0"]);
    expect(filterFunds(FUNDS, { ...NO_FILTER, query: "  sol " }).map((f) => f.code)).toEqual(["444200"]);
  });
  it("액티브·패시브와 운용사를 함께 건다", () => {
    expect(filterFunds(FUNDS, { ...NO_FILTER, style: "active" }).map((f) => f.code)).toEqual(["444200", "0222D0"]);
    expect(filterFunds(FUNDS, { ...NO_FILTER, style: "passive" }).map((f) => f.code)).toEqual(["091160"]);
    expect(filterFunds(FUNDS, { query: "", style: "active", issuer: "신한자산운용" }).map((f) => f.code)).toEqual(["444200"]);
  });
  it("조건이 없으면 전부 돌려주고 운용사는 가나다순으로 모은다", () => {
    expect(filterFunds(FUNDS, NO_FILTER)).toHaveLength(3);
    expect(issuersOf(FUNDS)).toEqual(["삼성자산운용", "신한자산운용", "타임폴리오자산운용"]);
  });
});

describe("squarify", () => {
  const inputs = [{ key: "a", weight: 40 }, { key: "b", weight: 25 }, { key: "c", weight: 15 }, { key: "d", weight: 12 }, { key: "e", weight: 8 }];
  const tiles = squarify(inputs, 160, 90);
  it("칸 면적이 가중치에 비례하고 전체 면적을 채운다", () => {
    const area = (key: string) => { const t = tiles.find((tile) => tile.key === key)!; return t.width * t.height; };
    expect(tiles.reduce((sum, t) => sum + t.width * t.height, 0)).toBeCloseTo(160 * 90, 6);
    expect(area("a") / area("e")).toBeCloseTo(5, 6);
  });
  it("칸이 서로 겹치지 않고 사각형 안에 든다", () => {
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(-1e-9);
      expect(t.y).toBeGreaterThanOrEqual(-1e-9);
      expect(t.x + t.width).toBeLessThanOrEqual(160 + 1e-9);
      expect(t.y + t.height).toBeLessThanOrEqual(90 + 1e-9);
    }
    for (const [i, p] of tiles.entries()) for (const q of tiles.slice(i + 1)) {
      const overlapX = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
      const overlapY = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
      expect(overlapX > 1e-9 && overlapY > 1e-9).toBe(false);
    }
  });
  it("비중이 0인 칸과 빈 입력은 칸을 만들지 않는다", () => {
    expect(squarify([{ key: "z", weight: 0 }, { key: "a", weight: 1 }], 10, 10).map((t) => t.key)).toEqual(["a"]);
    expect(squarify([], 10, 10)).toEqual([]);
    expect(squarify(inputs, 0, 10)).toEqual([]);
  });
  it("가장 큰 칸이 먼저 놓인다", () => {
    expect(tiles[0]!.key).toBe("a");
  });
});

describe("cumulativeCurve", () => {
  it("큰 비중부터 쌓고 합을 다시 맞추지 않는다", () => {
    expect(cumulativeCurve([500, 1900, 1000])).toEqual([
      { rank: 1, cumulativeBps: 1900 },
      { rank: 2, cumulativeBps: 2900 },
      { rank: 3, cumulativeBps: 3400 },
    ]);
    expect(cumulativeCurve([])).toEqual([]);
  });
});
