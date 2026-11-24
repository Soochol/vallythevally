import { expect, test } from "vitest";
import { collectedRuns } from "./replayDays";

const NINE_KST = Date.UTC(2026, 10, 20, 0, 0, 0) / 1000;
const DAY = 86_400;
const bars = [0, 1, 2].flatMap((day) => Array.from({ length: 4 }, (_, i) => ({ t: NINE_KST + day * DAY + i * 300 })));

test("수집된 날의 봉이 차지하는 구간만 이어진 하나로 돌려준다", () => {
  expect(collectedRuns(bars, new Set(["20261121", "20261122"]))).toEqual([[4, 11]]);
  expect(collectedRuns(bars, new Set(["20261120", "20261122"]))).toEqual([[0, 3], [8, 11]]);
  expect(collectedRuns(bars, new Set(["20261121"]))).toEqual([[4, 7]]);
  expect(collectedRuns(bars, new Set(["20261119"]))).toEqual([]);
  expect(collectedRuns(bars, new Set())).toEqual([]);
  expect(collectedRuns([], new Set(["20261120"]))).toEqual([]);
  const lateNight = [{ t: NINE_KST + 14 * 3600 }, { t: NINE_KST + 15 * 3600 }];
  expect(collectedRuns(lateNight, new Set(["20261120"]))).toEqual([[0, 0]]);
});
