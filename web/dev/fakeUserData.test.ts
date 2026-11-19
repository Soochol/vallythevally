import { expect, test } from "vitest";
import { isScreen } from "./fakeUserData.ts";

const screen = (exclude: unknown[]) => ({ id: "s1", name: "시험", markets: [], exclude, conditions: [] });

test("스크린의 빼기 값으로 etn·infrastructure·mutual_fund를 받는다", () => {
  expect(isScreen(screen(["etn", "infrastructure", "mutual_fund"]))).toBe(true);
});

test("모르는 빼기 값은 거절한다", () => {
  expect(isScreen(screen(["etn_x"]))).toBe(false);
  expect(isScreen(screen(["mutualFund"]))).toBe(false);
});
