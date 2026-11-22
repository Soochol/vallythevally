import { expect, test } from "vitest";
import { createUserData, isScreen } from "./fakeUserData.ts";

const screen = (exclude: unknown[]) => ({ id: "s1", name: "시험", markets: [], exclude, conditions: [] });

test("스크린의 빼기 값으로 etn·infrastructure·mutual_fund를 받는다", () => {
  expect(isScreen(screen(["etn", "infrastructure", "mutual_fund"]))).toBe(true);
});

test("모르는 빼기 값은 거절한다", () => {
  expect(isScreen(screen(["etn_x"]))).toBe(false);
  expect(isScreen(screen(["mutualFund"]))).toBe(false);
});

test("히트맵 테마는 더 큰 revision만 받고 이름 중복과 지수를 거절한다", () => {
  const user = createUserData(["005930", "000660"], []);
  expect(user.getHeatmapThemes().themes.map((t) => t.name)).toEqual(["반도체", "2차전지", "인터넷"]);
  const one = (name: string, symbols: string[]) => ({ id: name, name, symbols });
  expect(user.putHeatmapThemes({ themes: [one("가", ["005930"])], revision: 1 }).status).toBe(200);
  expect(user.putHeatmapThemes({ themes: [one("가", [])], revision: 1 }).status).toBe(409);
  expect(user.putHeatmapThemes({ themes: [one("가", []), { id: "b", name: "가", symbols: [] }], revision: 2 }).status).toBe(400);
  expect(user.putHeatmapThemes({ themes: [one("가", ["IDX:001"])], revision: 2 }).status).toBe(400);
  expect(user.getHeatmapThemes()).toEqual({ themes: [one("가", ["005930"])], revision: 1 });
});
