import { expect, test } from "vitest";
import { THEME_COLORS, themeColors } from "./groupColors";

test("테마 색은 id로 정해져 보드 순서가 바뀌어도 같고 여덟 개까지 서로 다르다", () => {
  const ids = ["holding", "chips", "a", "b", "c", "d", "e", "f"];
  const colors = themeColors(ids);
  expect(themeColors([...ids].reverse())).toEqual(colors);
  expect(new Set(colors.values()).size).toBe(THEME_COLORS.length);
});
