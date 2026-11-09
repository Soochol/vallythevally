import { expect, test } from "vitest";
import { addSymbol, moveSymbol, moveSymbolBy, removeSymbol } from "./watchlist";

const list = ["005930", "000660", "035420"] as const;

test("넣으면 끝에 붙고, 이미 있으면 그대로다", () => {
  expect(addSymbol(list, "IDX:001")).toEqual([...list, "IDX:001"]);
  expect(addSymbol(list, "000660")).toBe(list);
});

test("지우면 그 종목만 빠지고, 없는 종목이면 그대로다", () => {
  expect(removeSymbol(list, "000660")).toEqual(["005930", "035420"]);
  expect(removeSymbol(list, "999999")).toBe(list);
});

test("끌어 놓으면 그 자리로 옮긴다", () => {
  expect(moveSymbol(list, "035420", 0)).toEqual(["035420", "005930", "000660"]);
  expect(moveSymbol(list, "005930", 2)).toEqual(["000660", "035420", "005930"]);
  expect(moveSymbol(list, "005930", 99)).toEqual(["000660", "035420", "005930"]);
  expect(moveSymbol(list, "005930", 0)).toBe(list);
  expect(moveSymbol(list, "999999", 0)).toBe(list);
});

test("Alt+↑/↓는 한 칸씩 옮기고, 끝에서는 그대로다", () => {
  expect(moveSymbolBy(list, "000660", -1)).toEqual(["000660", "005930", "035420"]);
  expect(moveSymbolBy(list, "000660", 1)).toEqual(["005930", "035420", "000660"]);
  expect(moveSymbolBy(list, "005930", -1)).toBe(list);
  expect(moveSymbolBy(list, "035420", 1)).toBe(list);
});
