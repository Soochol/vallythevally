import { expect, test } from "vitest";
import type { Ranking } from "../../api/generated/Ranking";
import { startRanking } from "./rankingChoices";
import { RANKING_KINDS } from "./rankingKinds";
import { isRanking } from "./rankingShape";

const common = { market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false } as const;
const base = startRanking("tradeAmount", common) as Extract<Ranking, { kind: "tradeAmount" }>;
const program = startRanking("program", common) as Extract<Ranking, { kind: "program" }>;

test.each(RANKING_KINDS)("%s의 기본값은 순위로 읽힌다", (kind) => {
  expect(isRanking(startRanking(kind, common))).toBe(true);
});

test("종류는 맞고 필드가 빠졌거나 허용 값 밖인 값은 순위가 아니다", () => {
  const without = (from: object, field: string) => Object.fromEntries(Object.entries(from).filter(([key]) => key !== field));
  expect(isRanking({ kind: "tradeAmount" })).toBe(false);
  expect(isRanking({ ...base, market: "zzz" })).toBe(false);
  expect(isRanking({ ...base, venue: "nyse" })).toBe(false);
  expect(isRanking(without(base, "excludes"))).toBe(false);
  expect(isRanking(without(base, "excludeManaged"))).toBe(false);
  expect(isRanking({ ...base, excludes: { etfEtn: "yes", preferred: false } })).toBe(false);
  expect(isRanking({ ...base, excludes: { etfEtn: true } })).toBe(false);
  expect(isRanking({ ...base, excludes: [] })).toBe(false);
  expect(isRanking({ ...base, excludeManaged: 0 })).toBe(false);
});

test("프로그램과 호가잔량의 시장은 전체를 받지 않는다", () => {
  expect(isRanking({ ...program, market: "all" })).toBe(false);
  expect(isRanking({ ...startRanking("bidAskBalance", common), market: "all" })).toBe(false);
  expect(isRanking({ ...program, market: "kosdaq" })).toBe(true);
  expect(isRanking({ ...base, market: "all" })).toBe(true);
});

test("그 순위만의 열거 값도 허용 값 안이어야 한다", () => {
  expect(isRanking({ ...startRanking("tradeVolume", common), session: "night" })).toBe(false);
  expect(isRanking({ ...startRanking("volumeSurge", common), baseline: "minutes3" })).toBe(false);
  expect(isRanking({ ...startRanking("gainers", common), minTradeAmount: "atLeast1Million" })).toBe(false);
  expect(isRanking({ ...startRanking("gainers", common), includeLimit: "true" })).toBe(false);
  expect(isRanking({ ...startRanking("investorNetBuy", common), investor: "retail" })).toBe(false);
  expect(isRanking({ ...startRanking("foreignStreak", common), direction: "buy" })).toBe(false);
  expect(isRanking({ ...startRanking("mostViewed", common), span: "week" })).toBe(false);
});

test("순위가 아닌 값은 거절한다", () => {
  for (const value of [null, undefined, [], "tradeAmount", 1, {}, { kind: "nope" }, { kind: "__proto__" }, { kind: 1 }]) expect(isRanking(value)).toBe(false);
});

test("모르는 필드가 더 있어도 서버 serde처럼 받는다", () => {
  expect(isRanking({ ...base, extra: 1 })).toBe(true);
  expect(isRanking({ ...base, excludes: { ...base.excludes, extra: 1 } })).toBe(true);
});
