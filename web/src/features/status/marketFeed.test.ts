import { describe, expect, test } from "vitest";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { Ranking } from "../../api/generated/Ranking";
import { adaptRanking, choiceOn, feedMarkOf, marketFeatureOn, overviewFeatureOn, rankingKindOn } from "./marketFeed";

const kisFeed: NonNullable<MarketSourceStatus["feedBroker"]> = {
  broker: "kis",
  rankingKinds: ["tradeAmount", "mostViewed", "investorNetBuy"],
  rankingChoices: [
    { kind: "mostViewed", choices: { venues: [], sessions: [], baselines: [], surgeSorts: [], minTradeAmounts: [], investors: [], spans: ["today"], excludesManaged: false } },
    { kind: "investorNetBuy", choices: { venues: [], sessions: [], baselines: [], surgeSorts: [], minTradeAmounts: [], investors: ["foreign", "institution"], spans: [], excludesManaged: false } },
  ],
  overviewFeatures: ["index", "flow"],
};
const source = (patch: Partial<MarketSourceStatus> = {}): MarketSourceStatus => ({ broker: "kis", keyId: "kis1", alias: "한투 1", state: "connected", problem: null, step: null, retryAt: null, features: ["quotes"], feedBroker: kisFeed, ...patch });
const EXCLUDES = { etfEtn: true, preferred: false };
const mostViewed = (span: "minute1" | "today"): Ranking => ({ kind: "mostViewed", span, excludes: EXCLUDES });

describe("받는 증권사 표시", () => {
  test("받은 증권사가 시세 공급원과 다를 때만 표시한다", () => {
    expect(feedMarkOf(source(), "kiwoom")).toBe("kiwoom");
    expect(feedMarkOf(source(), "kis")).toBeNull();
    expect(feedMarkOf(null, "kiwoom")).toBeNull();
  });
});

describe("서버가 알려 준 집합으로 거르기", () => {
  test("알 수 없으면 모두 쓸 수 있고, 알면 집합에 든 것만 쓸 수 있다", () => {
    expect(rankingKindOn(null, "foreignStreak")).toBe(true);
    expect(rankingKindOn(source({ feedBroker: null }), "foreignStreak")).toBe(true);
    expect(rankingKindOn(source(), "foreignStreak")).toBe(false);
    expect(rankingKindOn(source(), "tradeAmount")).toBe(true);
    expect(overviewFeatureOn(source(), "streaks")).toBe(false);
    expect(overviewFeatureOn(source(), "flow")).toBe(true);
    expect(marketFeatureOn(source(), "minuteBars")).toBe(false);
    expect(marketFeatureOn(null, "minuteBars")).toBe(true);
  });
  test("선택값은 그 순위 종류의 목록에 든 것만 고를 수 있다", () => {
    const base = source();
    expect(choiceOn(base, mostViewed("minute1"), "span", "seconds30")).toBe(false);
    expect(choiceOn(base, mostViewed("minute1"), "span", "today")).toBe(true);
    expect(choiceOn(base, mostViewed("minute1"), "market", "kospi")).toBe(true);
    expect(choiceOn(null, mostViewed("minute1"), "span", "seconds30")).toBe(true);
  });
  test("고른 값이 목록에 없으면 첫 받는 값으로 바꾸고 문장으로 알린다", () => {
    const adapted = adaptRanking(source(), mostViewed("minute1"), (_field, value) => (value === "today" ? "당일 누적" : value));
    expect(adapted.ranking).toEqual(mostViewed("today"));
    expect(adapted.changes).toEqual(["조회 기간을 ‘당일 누적’으로 바꿨습니다"]);
    expect(adaptRanking(source(), mostViewed("today"), String).changes).toEqual([]);
  });
  test("바꾸는 문장의 조사는 받침을 따른다", () => {
    const investor: Ranking = { kind: "investorNetBuy", market: "all", investor: "investmentTrust", direction: "netBuy", unit: "amount", excludes: EXCLUDES };
    const adapted = adaptRanking(source(), investor, () => "외국인");
    expect(adapted.ranking).toMatchObject({ investor: "foreign" });
    expect(adapted.changes).toEqual(["투자자를 ‘외국인’으로 바꿨습니다"]);
  });
});
