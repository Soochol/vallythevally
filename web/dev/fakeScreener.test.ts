import { expect, test } from "vitest";
import type { ExcludeKind } from "../src/api/generated/ExcludeKind.ts";
import { createScreener } from "./fakeScreener.ts";
import { findSymbol } from "./fakeMarket.ts";

const now = Date.UTC(2026, 10, 9, 3, 0);

function symbolsOf(exclude: ExcludeKind[]): string[] {
  const reply = createScreener("ready", () => now).run({ id: "s1", name: "시험", markets: [], exclude, conditions: [] });
  expect(reply.status).toBe(200);
  return (reply.body as { rows: { symbol: string }[] }).rows.map((r) => r.symbol);
}

const everyone = symbolsOf([]);

test("가짜 종목 목록에 ETN·인프라·뮤추얼펀드가 하나씩 있다", () => {
  expect(["520100", "088980", "094800"].map((code) => findSymbol(code)?.kind)).toEqual(["etn", "infrastructure", "mutualFund"]);
  expect(everyone).toEqual(expect.arrayContaining(["520100", "088980", "094800"]));
});

test.each([
  ["etn", "520100"],
  ["infrastructure", "088980"],
  ["mutual_fund", "094800"],
] as const)("%s를 빼면 그 종류 종목만 결과에서 빠진다", (exclude, code) => {
  const kept = symbolsOf([exclude]);
  expect(kept).not.toContain(code);
  expect(kept).toHaveLength(everyone.length - 1);
});

test("가짜 스크리너가 미시 조건 3종과 결합 조건을 200으로 실행한다", () => {
  const screener = createScreener("ready", () => now);
  const cases = [
    [{ kind: "program_net_buy", days: 5, minMillionWon: 1000, maxMillionWon: null }],
    [{ kind: "whale_net_buy", days: 5, minMillionWon: 500, maxMillionWon: null }],
    [{ kind: "vi_triggered", days: 5, minCount: 1 }],
    [
      { kind: "program_net_buy", days: 5, minMillionWon: 1000, maxMillionWon: null },
      { kind: "whale_net_buy", days: 5, minMillionWon: 500, maxMillionWon: null },
      { kind: "vi_triggered", days: 5, minCount: 1 },
      { kind: "new_high", period: "D", recentBars: 1, field: "high", n: 60 },
    ],
  ];
  for (const conditions of cases) {
    const reply = screener.run({ id: "s-micro", name: "미시", markets: [], exclude: [], conditions });
    expect(reply.status).toBe(200);
  }
});
