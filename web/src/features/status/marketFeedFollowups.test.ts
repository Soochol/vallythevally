import { expect, test } from "vitest";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingChoicesView } from "../../api/generated/RankingChoicesView";
import type { RankingKind } from "../../api/generated/RankingKind";
import { adaptRanking } from "./marketFeed";

const NONE: RankingChoicesView = { venues: [], sessions: [], baselines: [], surgeSorts: [], minTradeAmounts: [], investors: [], spans: [], excludesManaged: false };

const kisSource = (choices: Partial<Record<RankingKind, Partial<RankingChoicesView>>>): MarketSourceStatus => ({
  broker: "kis",
  keyId: "kis1",
  alias: "한투 1",
  state: "connected",
  problem: null,
  step: null,
  retryAt: null,
  features: ["quotes"],
  feedBroker: {
    broker: "kis",
    rankingKinds: Object.keys(choices) as RankingKind[],
    rankingChoices: Object.entries(choices).map(([kind, patch]) => ({ kind: kind as RankingKind, choices: { ...NONE, ...patch } })),
    overviewFeatures: [],
  },
});

const EXCLUDES = { etfEtn: false, preferred: false };
const expected = (venue: "krx" | "nxt" | "combined"): Ranking => ({ kind: "expected", market: "all", venue, sort: "gainers", excludes: EXCLUDES, excludeManaged: true });
const tradeAmount: Ranking = { kind: "tradeAmount", market: "all", venue: "combined", excludes: EXCLUDES, excludeManaged: true };
const upper = (_field: string, value: string) => value.toUpperCase();
const korean = (_field: string, value: string) => (value === "combined" ? "통합" : value);

test("한투가 관리종목 빼기를 받지 않는 순위는 관리종목 빼기를 끈다", () => {
  const source = kisSource({ expected: { venues: ["combined", "krx"], excludesManaged: false }, tradeAmount: { venues: ["combined", "krx", "nxt"], excludesManaged: true } });
  const adapted = adaptRanking(source, expected("krx"), upper).ranking;
  expect(adapted.kind).toBe("expected");
  expect("excludeManaged" in adapted && adapted.excludeManaged).toBe(false);
  const kept = adaptRanking(source, tradeAmount, upper).ranking;
  expect("excludeManaged" in kept && kept.excludeManaged).toBe(true);
});

test("라틴 글자로 끝나는 라벨 뒤에는 ‘로’를 붙인다", () => {
  const toKrx = adaptRanking(kisSource({ expected: { venues: ["krx"], excludesManaged: true } }), expected("nxt"), upper).changes;
  expect(toKrx).toEqual(["거래소를 ‘KRX’로 바꿨습니다"]);
  const toNxt = adaptRanking(kisSource({ expected: { venues: ["nxt"], excludesManaged: true } }), expected("krx"), upper).changes;
  expect(toNxt).toEqual(["거래소를 ‘NXT’로 바꿨습니다"]);
  const toCombined = adaptRanking(kisSource({ expected: { venues: ["combined"], excludesManaged: true } }), expected("krx"), korean).changes;
  expect(toCombined).toEqual(["거래소를 ‘통합’으로 바꿨습니다"]);
});
