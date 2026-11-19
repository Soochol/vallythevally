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
