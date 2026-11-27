import { describe, expect, test } from "vitest";
import type { BookReplayProgramRow } from "../../api/generated/BookReplayProgramRow";
import { sliceProgramReplayAt } from "./programReplay";

const DATE = "20261123";
const MIDNIGHT = Date.UTC(2026, 10, 22, 15, 0, 0) / 1000;
const unixAt = (hour: number, minute: number, second = 0) => MIDNIGHT + hour * 3600 + minute * 60 + second;
const secAt = (hour: number, minute: number, second = 0) => hour * 3600 + minute * 60 + second;

const ROWS: readonly BookReplayProgramRow[] = [
  { secondOfDay: secAt(9, 0, 10), price: 71_000, buyQty: 100, sellQty: 40, netQty: 60, netQtyChange: 60, netAmountMillionWon: 420 },
  { secondOfDay: secAt(9, 1, 0), price: 71_100, buyQty: 150, sellQty: 90, netQty: 60, netQtyChange: 0, netAmountMillionWon: 420 },
  { secondOfDay: secAt(9, 2, 30), price: 71_200, buyQty: 300, sellQty: 100, netQty: 200, netQtyChange: 140, netAmountMillionWon: 1420 },
  { secondOfDay: secAt(9, 10, 15), price: 71_300, buyQty: 350, sellQty: 250, netQty: 100, netQtyChange: -100, netAmountMillionWon: 710 },
  { secondOfDay: secAt(9, 20, 0), price: 71_400, buyQty: 500, sellQty: 250, netQty: 250, netQtyChange: 150, netAmountMillionWon: 1780 },
];

describe("sliceProgramReplayAt", () => {
  test("returns empty slice when no rows exist at or before cutoff", () => {
    const empty = sliceProgramReplayAt(ROWS, [], DATE, unixAt(9, 0, 5));
    expect(empty).toEqual({ latest: undefined, lines: [], trend: [], rowCount: 0 });
  });

  test("slices rows via binary search, keeps trend across all rows, and inserts overlapping gaps", () => {
    const gaps: readonly (readonly [number, number])[] = [
      [unixAt(8, 50, 0), unixAt(8, 55, 0)],
      [unixAt(9, 4, 0), unixAt(9, 8, 0)],
      [unixAt(9, 15, 0), unixAt(9, 18, 0)],
    ];
    const result = sliceProgramReplayAt(ROWS, gaps, DATE, unixAt(9, 14, 59));

    expect(result.rowCount).toBe(4);
    expect(result.latest?.time).toBe("09:10:15");
    expect(result.latest?.netQty).toBe(100);
    expect(result.latest?.source).toBe("history");
    expect(result.trend).toEqual([60, 60, 200, 100]);
    expect(result.lines.map((line) => (line.kind === "gap" ? `gap:${line.time}` : `row:${line.row.time}`))).toEqual([
      "row:09:00:10",
      "row:09:01:00",
      "row:09:02:30",
      "gap:09:04:00",
      "row:09:10:15",
    ]);
  });

  test("appends gap that occurred after the last visible row up to cutoff", () => {
    const gaps: readonly (readonly [number, number])[] = [[unixAt(9, 4, 0), unixAt(9, 8, 0)]];
    const result = sliceProgramReplayAt(ROWS, gaps, DATE, unixAt(9, 9, 0));

    expect(result.rowCount).toBe(3);
    expect(result.lines.map((line) => (line.kind === "gap" ? `gap:${line.time}` : `row:${line.row.time}`))).toEqual([
      "row:09:00:10",
      "row:09:01:00",
      "row:09:02:30",
      "gap:09:04:00",
    ]);
  });

  test("places gap after a row when gap starts at that row timestamp for both first and later rows", () => {
    const laterRows: readonly BookReplayProgramRow[] = [
      { secondOfDay: secAt(9, 1, 0), price: 71_000, buyQty: 100, sellQty: 0, netQty: 100, netQtyChange: 100, netAmountMillionWon: 700 },
      { secondOfDay: secAt(9, 2, 0), price: 71_100, buyQty: 200, sellQty: 0, netQty: 200, netQtyChange: 100, netAmountMillionWon: 1400 },
      { secondOfDay: secAt(9, 5, 0), price: 71_200, buyQty: 300, sellQty: 0, netQty: 300, netQtyChange: 100, netAmountMillionWon: 2100 },
    ];
    const laterResult = sliceProgramReplayAt(laterRows, [[unixAt(9, 2, 0), unixAt(9, 4, 0)]], DATE, unixAt(9, 6, 0));
    expect(laterResult.lines.map((line) => (line.kind === "gap" ? `gap:${line.time}` : `row:${line.row.time}`))).toEqual([
      "row:09:01:00",
      "row:09:02:00",
      "gap:09:02:00",
      "row:09:05:00",
    ]);

    const firstRows: readonly BookReplayProgramRow[] = [laterRows[0]!, laterRows[2]!];
    const firstResult = sliceProgramReplayAt(firstRows, [[unixAt(9, 1, 0), unixAt(9, 4, 0)]], DATE, unixAt(9, 6, 0));
    expect(firstResult.lines.map((line) => (line.kind === "gap" ? `gap:${line.time}` : `row:${line.row.time}`))).toEqual([
      "row:09:01:00",
      "gap:09:01:00",
      "row:09:05:00",
    ]);
  });
});
