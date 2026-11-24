import { expect, test } from "vitest";
import { MAX_RANGE_DAYS, missingRanges } from "./coverage";

test("빠진 날짜만 31일씩 새것부터 나눈다", () => {
  expect(MAX_RANGE_DAYS).toBe(31);
  expect(missingRanges({ from: "2026-11-23", to: "2026-11-24" }, null)).toEqual([{ from: "2026-11-23", to: "2026-11-24" }]);
  expect(missingRanges({ from: "2026-09-20", to: "2026-11-24" }, null)).toEqual([
    { from: "2026-10-25", to: "2026-11-24" },
    { from: "2026-09-24", to: "2026-10-24" },
    { from: "2026-09-20", to: "2026-09-23" },
  ]);
  const have = { from: "2026-11-10", to: "2026-11-23" };
  expect(missingRanges({ from: "2026-11-12", to: "2026-11-20" }, have)).toEqual([]);
  expect(missingRanges({ from: "2026-11-10", to: "2026-11-25" }, have)).toEqual([{ from: "2026-11-24", to: "2026-11-25" }]);
  expect(missingRanges({ from: "2026-10-08", to: "2026-11-25" }, have)).toEqual([
    { from: "2026-11-24", to: "2026-11-25" },
    { from: "2026-10-10", to: "2026-11-09" },
    { from: "2026-10-08", to: "2026-10-09" },
  ]);
  expect(missingRanges({ from: "2028-02-28", to: "2028-03-01" }, null)).toEqual([{ from: "2028-02-28", to: "2028-03-01" }]);
});
