import { describe, expect, it } from "vitest";
import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import {
  activityScore,
  commonHoldings,
  filterChangeRows,
  filterFunds,
  formatAumWon,
  formatFlowWon,
  formatRealChange,
  formatScale,
  formatSharesCount,
  fullRangePair,
  holdingsBreadth,
  isGlobalTab,
  issuersOf,
  maAlignedCount,
  NO_FILTER,
  overlapBps,
  pairOf,
  parseBasket,
  projectChangeRow,
  rankHoldings,
  sortFunds,
  squarify,
  uniqueHoldings,
} from "./etfModel";

const fund = (
  code: string,
  name: string,
  style: EtfFundSummary["style"],
  issuer: string,
  recentActivity: EtfFundSummary["recentActivity"] = null,
  latestAumWon: number | null = null,
  netFlow5dWon: number | null = null,
): EtfFundSummary => ({
  code, name, issuer, style, benchmark: "", holdingsCount: 1, top5WeightBps: 100, effectiveHoldings: 1,
  status: { source: "snapshot", holdingsAsOf: "2026-10-30", lastAttemptAt: null, refreshFailed: false },
  recentActivity,
  latestAumWon,
  netFlow5dWon,
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
    { ...fund("a", "다", "passive", "x", { added: 0, removed: 0, increased: 1, decreased: 0 }), top5WeightBps: 3000, holdingsCount: 10, effectiveHoldings: 12.4 },
    { ...fund("b", "가", "passive", "x", null), top5WeightBps: 9000, holdingsCount: 5, effectiveHoldings: 4.2 },
    { ...fund("c", "나", "passive", "x", { added: 1, removed: 1, increased: 1, decreased: 1 }), top5WeightBps: 6000, holdingsCount: 50, effectiveHoldings: 8.1 },
  ];
  it("이름순은 가나다 순이다", () => expect(sortFunds(sized, "name").map((f) => f.code)).toEqual(["b", "c", "a"]));
  it("상위 5 비중순은 큰 것부터다", () => expect(sortFunds(sized, "top5").map((f) => f.code)).toEqual(["b", "c", "a"]));
  it("종목 수순은 많은 것부터다", () => expect(sortFunds(sized, "count").map((f) => f.code)).toEqual(["c", "a", "b"]));
  it("실효 종목순은 적은 것(집중형)부터다", () => expect(sortFunds(sized, "effective").map((f) => f.code)).toEqual(["b", "c", "a"]));
  it("최근 리밸런싱순은 활동 점수가 높은 순이며 활동 기록이 없으면 뒤로 간다", () => {
    expect(activityScore(null)).toBe(-1);
    expect(activityScore({ added: 0, removed: 0, increased: 0, decreased: 0 })).toBe(0);
    expect(activityScore({ added: 1, removed: 1, increased: 1, decreased: 1 })).toBe(8);
    expect(sortFunds(sized, "activity").map((f) => f.code)).toEqual(["c", "a", "b"]);
    const tied = [
      fund("d", "라", "passive", "x", null),
      fund("e", "가", "passive", "x", null),
      fund("f", "나", "passive", "x", { added: 0, removed: 0, increased: 0, decreased: 0 }),
    ];
    expect(sortFunds(tied, "activity").map((f) => f.code)).toEqual(["f", "e", "d"]);
  });
  it("원래 배열을 바꾸지 않는다", () => {
    sortFunds(sized, "count");
    expect(sized.map((f) => f.code)).toEqual(["a", "b", "c"]);
  });
  it("자금 유입·유출·순자산순 정렬은 결측 값을 뒤로 둔다", () => {
    const flowFunds = [
      fund("a", "다", "passive", "x", null, 300_000_000_000, -12_000_000_000),
      fund("b", "가", "passive", "x", null, null, null),
      fund("c", "나", "passive", "x", null, 800_000_000_000, 45_000_000_000),
    ];
    expect(sortFunds(flowFunds, "flow_in").map((f) => f.code)).toEqual(["c", "a", "b"]);
    expect(sortFunds(flowFunds, "flow_out").map((f) => f.code)).toEqual(["a", "c", "b"]);
    expect(sortFunds(flowFunds, "aum").map((f) => f.code)).toEqual(["c", "a", "b"]);
    expect(formatFlowWon(45_000_000_000)).toBe("+450억");
    expect(formatFlowWon(-12_300_000_000)).toBe("-123억");
    expect(formatAumWon(1_250_000_000_000)).toBe("1.25조원");
    expect(formatSharesCount(19_200_000)).toBe("1,920만좌");
    expect(isGlobalTab("flows")).toBe(true);
    expect(isGlobalTab("shares")).toBe(false);
  });
});

describe("rankHoldings", () => {
  it("서버가 준 순서대로 순위와 누적 비중을 매기고 다시 정렬하지 않는다", () => {
    const ranked = rankHoldings([{ code: "b", name: "b", weightBps: 1900 }, { code: "c", name: "c", weightBps: 1000 }, { code: "a", name: "a", weightBps: 500 }]);
    expect(ranked.map((r) => [r.holding.code, r.rank, r.cumulativeBps])).toEqual([["b", 1, 1900], ["c", 2, 2900], ["a", 3, 3400]]);
    const unsorted = rankHoldings([{ code: "a", name: "a", weightBps: 500 }, { code: "b", name: "b", weightBps: 1900 }]);
    expect(unsorted.map((r) => r.holding.code)).toEqual(["a", "b"]);
  });
  it("비면 빈 목록이다", () => {
    expect(rankHoldings([])).toEqual([]);
  });
});

describe("holdingsBreadth and maAlignedCount", () => {
  const row = (code: string, ma: EtfHolding["ma"]): EtfHolding => ({ code, name: code, weightBps: 1000, ma });
  it("이평선 정배열 개수와 건전성 비율을 계산한다", () => {
    expect(maAlignedCount({ ma20: "above", ma60: "above", ma120: "above" })).toBe(3);
    expect(maAlignedCount({ ma20: "above", ma60: "below", ma120: null })).toBe(1);
    const items = [
      row("1", { ma20: "above", ma60: "above", ma120: "above" }),
      row("2", { ma20: "above", ma60: "below", ma120: "equal" }),
      row("3", { ma20: "below", ma60: "below", ma120: "below" }),
      row("4", { ma20: null, ma60: null, ma120: null }),
    ];
    expect(holdingsBreadth(items)).toEqual({ evaluated: 3, above20Pct: 67, aligned3Pct: 33 });
    expect(holdingsBreadth([row("4", { ma20: null, ma60: null, ma120: null })])).toEqual({ evaluated: 0, above20Pct: 0, aligned3Pct: 0 });
  });
});

describe("overlapBps and uniqueHoldings", () => {
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
  it("고유 종목을 비중 내림차순으로 가른다", () => {
    const u = uniqueHoldings(holdings([["a", 1000], ["e", 4000], ["b", 3000]]), B);
    expect(u.onlyA.map((h) => h.code)).toEqual(["e", "a"]);
    expect(u.onlyB.map((h) => h.code)).toEqual(["c", "d"].reverse());
  });
});

describe("parseBasket and isGlobalTab", () => {
  it("중복과 빈 값을 버리고 4개까지만 남긴다", () => {
    expect(parseBasket(null)).toEqual([]);
    expect(parseBasket("a,,b,a,c,d,e,f")).toEqual(["a", "b", "c", "d"]);
  });
  it("전역 탭과 개별 ETF 탭을 구분한다", () => {
    expect(isGlobalTab("accumulation")).toBe(true);
    expect(isGlobalTab("overlap")).toBe(true);
    expect(isGlobalTab("reverse")).toBe(true);
    expect(isGlobalTab("holdings")).toBe(false);
    expect(isGlobalTab("history")).toBe(false);
    expect(isGlobalTab("similar")).toBe(false);
  });
});

describe("편입 변경 표시와 X-Ray 투영", () => {
  const pair = (before: string, after: string): EtfChangePair => ({ before, after, commonScale: 1, added: 0, removed: 0, increased: 0, decreased: 0 });
  const pairs = [pair("2026-11-14", "2026-11-18"), pair("2026-11-10", "2026-11-14")];

  it("고른 쌍이 없거나 목록에 없으면 가장 최근 쌍을 쓴다", () => {
    expect(pairOf(pairs, "2026-11-14")).toBe(pairs[1]);
    expect(pairOf(pairs, null)).toBe(pairs[0]);
    expect(pairOf(pairs, "2020-01-01")).toBe(pairs[0]);
    expect(pairOf([], null)).toBeNull();
  });

  it("전체 구간 쌍은 2개 이상일 때 첫 시작일과 마지막 종료일을 묶는다", () => {
    expect(fullRangePair(pairs)).toEqual({ before: "2026-11-10", after: "2026-11-18" });
    expect(fullRangePair([pairs[0]!])).toBeNull();
    expect(fullRangePair([])).toBeNull();
  });

  it("실질 증감은 부호와 소수 첫째 자리 퍼센트로, 공통 배율은 소수 셋째 자리로 적는다", () => {
    expect(formatRealChange(0.1234)).toBe("+12.3%");
    expect(formatRealChange(-0.0159)).toBe("-1.6%");
    expect(formatScale(0.9402730375)).toBe("×0.940");
    expect(formatScale(null)).toBe("-");
  });

  it("CU 보정 X-Ray ON/OFF에 따라 노이즈 행의 분류와 변화율이 달라진다", () => {
    const noiseRow: EtfChangeRow = { code: "035420", name: "NAVER", beforeQuantity: 800, afterQuantity: 752, realChange: 0, kind: "unchanged" };
    const buyRow: EtfChangeRow = { code: "000660", name: "SK하이닉스", beforeQuantity: 1000, afterQuantity: 1200, realChange: 0.2766, kind: "increased" };
    const addedRow: EtfChangeRow = { code: "402340", name: "SK스퀘어", beforeQuantity: null, afterQuantity: 50, realChange: null, kind: "added" };

    const noiseOn = projectChangeRow(noiseRow, true);
    expect(noiseOn.kind).toBe("unchanged");
    expect(noiseOn.change).toBe(0);
    expect(noiseOn.isScaleNoise).toBe(true);

    const noiseOff = projectChangeRow(noiseRow, false);
    expect(noiseOff.kind).toBe("decreased");
    expect(noiseOff.change).toBeCloseTo(-0.06, 6);
    expect(noiseOff.isScaleNoise).toBe(true);

    const buyOff = projectChangeRow(buyRow, false);
    expect(buyOff.kind).toBe("increased");
    expect(buyOff.change).toBeCloseTo(0.2, 6);

    const addedOff = projectChangeRow(addedRow, false);
    expect(addedOff.kind).toBe("added");
    expect(addedOff.change).toBeNull();

    const projected = [noiseOn, projectChangeRow(buyRow, true), projectChangeRow(addedRow, true)];
    expect(filterChangeRows(projected, "changed").map((p) => p.row.code)).toEqual(["000660", "402340"]);
    expect(filterChangeRows(projected, "buy").map((p) => p.row.code)).toEqual(["000660", "402340"]);
    expect(filterChangeRows(projected, "sell")).toEqual([]);
  });
});
