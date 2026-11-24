import { expect, test } from "vitest";
import type { ProgramTradePoint } from "../../api/generated/ProgramTradePoint";
import { boldKeys, eokFromMillionWon, historyRows, isNoProgramData, joinHistoryAndLive, liveRow, nonZeroChangeLines, rowsOf, widestSoFar, type ProgramLine, type ProgramRow } from "./program";

const KST_0905 = Date.parse("2026-11-09T09:05:00+09:00") / 1000;
const point = (time: string, netQuantity: number): ProgramTradePoint => ({ time, price: 70_000, buyQuantity: 10, sellQuantity: 5, netQuantity, buyAmount: 0, sellAmount: 0, netAmount: netQuantity * 70_000_000 });
const row = (key: string, change: number): ProgramRow => ({ key, source: "live", time: "09:00:00", price: null, netQty: 0, netQtyChange: change, netAmountMillionWon: 0, buyQty: 0, sellQty: 0 });
const live = (...rows: ProgramRow[]): ProgramLine[] => rows.map((r) => ({ kind: "row", row: r }));

test("키움의 백만원은 억원으로 바뀐다", () => {
  expect(eokFromMillionWon(100)).toBe(1);
  expect(eokFromMillionWon(-2_550)).toBe(-25.5);
  expect(eokFromMillionWon(5)).toBe(0.05);
});

test("REST의 원 금액은 백만원으로 맞춰 실시간과 같은 단위가 된다", () => {
  expect(historyRows([point("09:00:00", 3)])[0]!.netAmountMillionWon).toBe(210);
});

test("조회가 어느 순서로 와도 시각순으로 놓고 증감은 앞 행과의 차다", () => {
  const rows = historyRows([point("09:02:00", 50), point("09:00:00", 10), point("09:01:00", 30)]);
  expect(rows.map((r) => [r.time, r.netQty, r.netQtyChange])).toEqual([["09:00:00", 10, 10], ["09:01:00", 30, 20], ["09:02:00", 50, 20]]);
});

test("조회와 실시간이 겹치면 첫 실시간 행 시각 이상의 조회 행은 버리고 실시간만 남는다", () => {
  const history = historyRows([point("09:03:00", 1), point("09:04:00", 2), point("09:05:00", 3), point("09:06:00", 4)]);
  const first = liveRow({ t: KST_0905, price: 70_000, sellQty: 0, sellAmount: 0, buyQty: 0, buyAmount: 0, netQty: 9, netQtyChange: 6, netAmount: 0, netAmountChange: 0 }, 0);
  expect(first.time).toBe("09:05:00");
  const joined = rowsOf(joinHistoryAndLive(history, live(first)));
  expect(joined.map((r) => [r.source, r.time])).toEqual([["history", "09:03:00"], ["history", "09:04:00"], ["live", "09:05:00"]]);
});

test("실시간 행이 없으면 조회 행을 모두 둔다", () => {
  const history = historyRows([point("09:03:00", 1)]);
  expect(joinHistoryAndLive(history, [])).toHaveLength(1);
});

test("끊김 줄은 실시간 쪽에 있어도 조회 행을 자르는 기준이 아니다", () => {
  const history = historyRows([point("09:03:00", 1)]);
  const lines = joinHistoryAndLive(history, [{ kind: "gap", key: "gap-0", time: "09:04:00" }]);
  expect(lines.map((l) => l.kind)).toEqual(["row", "gap"]);
});

test("보이는 행의 증감 크기 상위 10%만 굵게 한다", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`r${i}`, (i + 1) * (i % 2 ? -1 : 1)));
  expect([...boldKeys(rows)].sort()).toEqual(["r18", "r19"]);
});

test("행이 열 개보다 적어도 가장 큰 증감 하나는 굵고 증감이 모두 0이면 굵은 행이 없다", () => {
  expect([...boldKeys([row("a", 1), row("b", -7), row("c", 3)])]).toEqual(["b"]);
  expect(boldKeys([row("a", 0), row("b", 0)]).size).toBe(0);
  expect(boldKeys([]).size).toBe(0);
});

test("열 너비는 지금까지 본 최댓값에서 줄지 않는다", () => {
  const first = widestSoFar([0, 0, 0], ["09:00:00", "70,000", "+1,234"]);
  expect(widestSoFar(first, ["09:00:01", "7,000", "+5"])).toEqual([8, 6, 6]);
  expect(widestSoFar(first, ["09:00:01", "170,000", "+5"])).toEqual([8, 7, 6]);
});

test("자료 없음은 조회가 비고 실시간 행도 없을 때다", () => {
  expect(isNoProgramData([], [])).toBe(true);
  expect(isNoProgramData([], [{ kind: "gap", key: "g", time: "09:00:00" }])).toBe(true);
  expect(isNoProgramData([], live(row("a", 1)))).toBe(false);
  expect(isNoProgramData(historyRows([point("09:00:00", 1)]), [])).toBe(false);
});

test("순매수 증감이 0인 행은 빼고 끊김 줄과 0이 아닌 행만 남긴다", () => {
  const lines: ProgramLine[] = [
    { kind: "row", row: row("a", 10) },
    { kind: "row", row: row("b", 0) },
    { kind: "gap", key: "g", time: "09:01:00" },
    { kind: "row", row: row("c", -5) },
    { kind: "row", row: row("d", 0) },
  ];
  expect(nonZeroChangeLines(lines).map((line) => (line.kind === "gap" ? line.key : line.row.key))).toEqual(["a", "g", "c"]);
});
