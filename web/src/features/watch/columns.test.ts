import { expect, test } from "vitest";
import { WATCH_COLUMNS } from "../../lib/watchlist";
import { fitColumns, fittedWidth } from "./columns";

test("창 폭에 들어가는 만큼 고른 열을 앞에서부터 남기고 첫 열은 언제나 남긴다", () => {
  const all = WATCH_COLUMNS;
  expect(fitColumns(all, fittedWidth(all))).toBe(all);
  expect(fitColumns(all, fittedWidth(all) - 1)).toEqual(all.slice(0, -1));
  expect(fitColumns(all, fittedWidth(all.slice(0, 2)))).toEqual(all.slice(0, 2));
  expect(fitColumns(all, 0)).toEqual(all.slice(0, 1));
  expect(fitColumns([], 0)).toEqual([]);
});
