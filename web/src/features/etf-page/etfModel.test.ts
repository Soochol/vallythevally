import { describe, expect, it } from "vitest";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import { commonHoldings, filterFunds, formatRealChange, formatScale, issuersOf, NO_FILTER, overlapBps, pairOf, parseBasket, rankHoldings, sortFunds, squarify } from "./etfModel";

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

describe("sortFunds", () => {
  const sized = [
    { ...fund("a", "다", "passive", "x"), top5WeightBps: 3000, holdingsCount: 10 },
    { ...fund("b", "가", "passive", "x"), top5WeightBps: 9000, holdingsCount: 5 },
    { ...fund("c", "나", "passive", "x"), top5WeightBps: 6000, holdingsCount: 50 },
  ];
  it("이름순은 가나다 순이다", () => expect(sortFunds(sized, "name").map((f) => f.code)).toEqual(["b", "c", "a"]));
  it("상위 5 비중순은 큰 것부터다", () => expect(sortFunds(sized, "top5").map((f) => f.code)).toEqual(["b", "c", "a"]));
  it("종목 수순은 많은 것부터다", () => expect(sortFunds(sized, "count").map((f) => f.code)).toEqual(["c", "a", "b"]));
  it("원래 배열을 바꾸지 않는다", () => {
    sortFunds(sized, "count");
    expect(sized.map((f) => f.code)).toEqual(["a", "b", "c"]);
  });
});

describe("rankHoldings", () => {
  it("큰 비중부터 순위와 누적 비중을 매긴다", () => {
    const ranked = rankHoldings([{ code: "a", name: "a", weightBps: 500 }, { code: "b", name: "b", weightBps: 1900 }, { code: "c", name: "c", weightBps: 1000 }]);
    expect(ranked.map((r) => [r.holding.code, r.rank, r.cumulativeBps])).toEqual([["b", 1, 1900], ["c", 2, 2900], ["a", 3, 3400]]);
  });
});

describe("overlapBps", () => {
  const holdings = (entries: readonly (readonly [string, number])[]) => entries.map(([code, weightBps]) => ({ code, name: code, weightBps }));
  const A = holdings([["a", 5000], ["b", 3000], ["c", 2000]]);
  const B = holdings([["b", 4500], ["c", 500], ["d", 5000]]);

  it("같은 ETF끼리는 100%다", () => {
    expect(overlapBps(A, A)).toBe(10_000);
  });
  it("공통 종목이 없으면 0이다", () => {
    expect(overlapBps(A, holdings([["x", 6000], ["y", 4000]]))).toBe(0);
  });
  it("3종목 손계산: b는 min(3000,4500)=3000, c는 min(2000,500)=500이라 3500bp", () => {
    expect(overlapBps(A, B)).toBe(3500);
    expect(overlapBps(B, A)).toBe(3500);
  });
  it("bp 정수끼리만 더해 소수 비중의 부동소수 오차가 없다", () => {
    const tenths = holdings([["a", 1], ["b", 2], ["c", 7]]);
    expect(overlapBps(tenths, holdings([["a", 1], ["b", 2], ["c", 7]]))).toBe(10);
    expect(Number.isInteger(overlapBps(A, B))).toBe(true);
  });
  it("공통 종목은 겹침이 큰 순이고 양쪽 비중을 함께 준다", () => {
    expect(commonHoldings(A, B)).toEqual([
      { code: "b", name: "b", weightABps: 3000, weightBBps: 4500 },
      { code: "c", name: "c", weightABps: 2000, weightBBps: 500 },
    ]);
  });
});

describe("parseBasket", () => {
  it("중복과 빈 값을 버리고 4개까지만 남긴다", () => {
    expect(parseBasket(null)).toEqual([]);
    expect(parseBasket("a,,b,a,c,d,e,f")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("편입 변경 표시", () => {
  const pair = (before: string, after: string): EtfChangePair => ({ before, after, commonScale: 1, added: 0, removed: 0, increased: 0, decreased: 0 });
  const pairs = [pair("2026-11-14", "2026-11-18"), pair("2026-11-10", "2026-11-14")];

  it("고른 쌍이 없거나 목록에 없으면 가장 최근 쌍을 쓴다", () => {
    expect(pairOf(pairs, "2026-11-14")).toBe(pairs[1]);
    expect(pairOf(pairs, null)).toBe(pairs[0]);
    expect(pairOf(pairs, "2020-01-01")).toBe(pairs[0]);
    expect(pairOf([], null)).toBeNull();
  });

  it("실질 증감은 부호와 소수 첫째 자리 퍼센트로, 공통 배율은 소수 셋째 자리로 적는다", () => {
    expect(formatRealChange(0.1234)).toBe("+12.3%");
    expect(formatRealChange(-0.0159)).toBe("-1.6%");
    expect(formatScale(0.9402730375)).toBe("×0.940");
    expect(formatScale(null)).toBe("-");
  });
});
