import { expect, test } from "vitest";
import type { Ranking } from "../../api/generated/Ranking";
import { RANKING_CATEGORIES, changeRankingKind, conditionsOf, marketOptions, startRanking } from "./rankingChoices";
import { RANKING_KINDS } from "./rankingKinds";

const common = { market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } as const;

test("분류가 13종 순위를 한 번씩 모두 담는다", () => {
  expect(RANKING_CATEGORIES.flatMap((c) => c.kinds).sort()).toEqual([...RANKING_KINDS].sort());
});

test("순위를 바꾸면 시장·거래소·빼기는 옮기고 그 순위만의 조건은 기본값으로 시작한다", () => {
  const from: Ranking = { kind: "tradeVolume", market: "kosdaq", venue: "krx", session: "regular", excludes: { etfEtn: false, preferred: true }, excludeManaged: true };
  expect(changeRankingKind(from, "gainers", "combined")).toEqual({
    kind: "gainers",
    market: "kosdaq",
    venue: "krx",
    includeLimit: true,
    minTradeAmount: "any",
    excludes: { etfEtn: false, preferred: true },
    excludeManaged: true,
  });
});

test("시장 전체가 없는 순위로 바꾸면 코스피로 시작하고 있는 시장은 그대로 둔다", () => {
  expect(changeRankingKind(startRanking("tradeAmount", common), "program", "combined")).toMatchObject({ kind: "program", market: "kospi" });
  expect(changeRankingKind(startRanking("tradeAmount", common), "bidAskBalance", "combined")).toMatchObject({ kind: "bidAskBalance", market: "kospi" });
  expect(changeRankingKind(startRanking("tradeAmount", { ...common, market: "kosdaq" }), "program", "combined")).toMatchObject({ market: "kosdaq" });
  expect(marketOptions("program")).toEqual(["kospi", "kosdaq"]);
  expect(marketOptions("tradeAmount")).toEqual(["all", "kospi", "kosdaq"]);
});

test("거래소나 시장이 없는 순위에서 옮길 때는 앱 거래소와 전체로 시작한다", () => {
  const viewed = startRanking("mostViewed", common);
  expect(changeRankingKind(viewed, "tradeAmount", "nxt")).toMatchObject({ market: "all", venue: "nxt", excludeManaged: false });
  expect(changeRankingKind(startRanking("tradeAmount", { ...common, venue: "krx" }), "investorNetBuy", "nxt")).not.toHaveProperty("venue");
});

test("같은 순위로 바꾸면 그대로다", () => {
  const same = startRanking("losers", common);
  expect(changeRankingKind(same, "losers", "nxt")).toBe(same);
});

test("모든 순위가 자기 변형이 가진 조건만 보인다", () => {
  for (const kind of RANKING_KINDS) {
    const ranking = startRanking(kind, common);
    const ids = conditionsOf(ranking).map((c) => c.id);
    expect(ids.includes("venue")).toBe("venue" in ranking);
    expect(ids.includes("excludeManaged")).toBe("excludeManaged" in ranking);
    expect(ids.includes("market")).toBe("market" in ranking);
    expect(ids).toContain("etfEtn");
    expect(ids).toContain("preferred");
  }
  expect(conditionsOf(startRanking("mostViewed", common)).map((c) => c.id)).toEqual(["span", "etfEtn", "preferred"]);
});

test("조건을 바꾸면 그 필드만 바뀐 새 순위를 만든다", () => {
  const ranking = startRanking("volumeSurge", common);
  const sort = conditionsOf(ranking).find((c) => c.id === "sort");
  expect(sort?.type === "choice" && sort.set("dropRate")).toEqual({ ...ranking, sort: "dropRate" });
  const managed = conditionsOf(ranking).find((c) => c.id === "excludeManaged");
  expect(managed?.type === "toggle" && managed.set(true)).toEqual({ ...ranking, excludeManaged: true });
  const etf = conditionsOf(ranking).find((c) => c.id === "etfEtn");
  expect(etf?.type === "toggle" && etf.set(false)).toEqual({ ...ranking, excludes: { etfEtn: false, preferred: false } });
});
