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
  expect(arrange(data, "equal", "custom", 160, 90).rows.map((r) => r.code)).toEqual(["A", "B", "C"]);
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

test("등락률순은 상승·보합·하락 묶음으로 나눠 묶음마다 모여 있다", () => {
  const data = rows([quote("A", 1, 30), quote("B", 5, 10), quote("C", -2, 20)]);
  const placed = arrange(data, "traded", "rate", 160, 90);
  const rect = (c: string) => placed.rects.get(code(c))!;
  const upBox = { x0: Math.min(rect("A").x, rect("B").x), x1: Math.max(rect("A").x + rect("A").w, rect("B").x + rect("B").w), y0: Math.min(rect("A").y, rect("B").y), y1: Math.max(rect("A").y + rect("A").h, rect("B").y + rect("B").h) };
  const down = rect("C");
  const apart = down.x >= upBox.x1 - 1e-9 || down.x + down.w <= upBox.x0 + 1e-9 || down.y >= upBox.y1 - 1e-9 || down.y + down.h <= upBox.y0 + 1e-9;
  expect(apart).toBe(true);
  expect([...placed.rects.values()].reduce((sum, r) => sum + r.w * r.h, 0)).toBeCloseTo(160 * 90, 6);
});

test("등락률순 묶음 배치는 길쭉한 칸을 줄인다", () => {
  const members = Array.from({ length: 24 }, (_, i) => quote(`S${i}`, ((i * 7) % 15) - 7, 1000 / (i + 1)));
  const data = boardRows({ id: "T", name: "테마", summary: null, members, missing: [] }, new Map());
  const placed = arrange(data, "traded", "rate", 160, 90);
  const stretched = [...placed.rects.values()].filter((r) => Math.max(r.w / r.h, r.h / r.w) > 4);
  expect(placed.rects.size).toBe(24);
  expect(stretched.length).toBeLessThanOrEqual(2);
});
