import { expect, test } from "vitest";
import type { HeatmapBoardMember } from "../../api/generated/HeatmapBoardMember";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { arrange, boardRows, tileWeights } from "./arrange";

const code = (c: string) => c as SymbolCode;
const NAMES: Record<string, string> = { A: "가", B: "나", C: "다" };
const quote = (symbol: string, changeRate: number, tradedMillionWon?: number): HeatmapBoardMember => ({ symbol: code(symbol), name: NAMES[symbol] ?? symbol, changeRate, ...(tradedMillionWon === undefined ? {} : { tradedMillionWon }) });
const names = new Map(Object.entries(NAMES).map(([c, name]) => [code(c), name] as const));
const rows = (members: HeatmapBoardMember[]) => {
  const quoted = new Set(members.map((m) => m.symbol));
  return boardRows({ id: "T", name: "테마", summary: null, members, missing: ["A", "B", "C"].map(code).filter((c) => !quoted.has(c)) }, names);
};

test("정렬 기준마다 순서가 정해진다", () => {
  const data = rows([quote("A", 1, 30), quote("B", 5, 10), quote("C", -2, 20)]);
  expect(arrange(data, "equal", "rate", 160, 90).rows.map((r) => r.code)).toEqual(["B", "A", "C"]);
  expect(arrange(data, "equal", "traded", 160, 90).rows.map((r) => r.code)).toEqual(["A", "C", "B"]);
  expect(arrange(data, "equal", "name", 160, 90).rows.map((r) => r.code)).toEqual(["A", "B", "C"]);
});

test("크기 기준이 거래대금이면 넓이가 거래대금 비율이고 같게면 모두 같다", () => {
  const data = rows([quote("A", 1, 300), quote("B", 5, 100), quote("C", -2, 100)]);
  const area = (a: ReturnType<typeof arrange>, c: string) => a.rects.get(code(c))!.w * a.rects.get(code(c))!.h;
  const traded = arrange(data, "traded", "rate", 160, 90);
  expect(area(traded, "A") / area(traded, "B")).toBeCloseTo(3, 6);
  const equal = arrange(data, "equal", "rate", 160, 90);
  expect(area(equal, "A")).toBeCloseTo(area(equal, "B"), 6);
});

test("거래대금이 하나도 없으면 같은 크기이고 빠진 종목은 가장 작은 칸이다", () => {
  expect(tileWeights(rows([quote("A", 1), quote("B", 2)]), "traded")).toEqual([1, 1, 1]);
  expect(tileWeights(rows([quote("A", 1, 50), quote("C", 2, 20)]), "traded")).toEqual([50, 20, 20]);
});

test("자리는 스냅샷으로만 정해져 실시간 등락률이 바뀌어도 그대로다", () => {
  const snapshot = rows([quote("A", 1, 30), quote("B", 5, 10), quote("C", -2, 20)]);
  const before = arrange(snapshot, "traded", "rate", 160, 90);
  const again = arrange(snapshot, "traded", "rate", 160, 90);
  expect(again).toEqual(before);
  const nextMinute = arrange(rows([quote("A", 9, 30), quote("B", 5, 10), quote("C", -2, 20)]), "traded", "rate", 160, 90);
  expect(nextMinute.rows.map((r) => r.code)).toEqual(["A", "B", "C"]);
  expect(before.rows.map((r) => r.code)).toEqual(["B", "A", "C"]);
});
