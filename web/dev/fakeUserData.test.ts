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

test("미시 조건 3종은 저장되고 잘못된 미시 조건은 400으로 거절된다", () => {
  const user = createUserData(["005930"], []);
  const validConditions = [
    { kind: "program_net_buy", days: 5, minMillionWon: 1000, maxMillionWon: null },
    { kind: "whale_net_buy", days: 10, minMillionWon: -500, maxMillionWon: 2000 },
    { kind: "vi_triggered", days: 3, minCount: 1 },
    { kind: "new_high", period: "D", recentBars: 1, field: "high", n: 60 },
  ];
  const validScreen = { id: "s-micro", name: "미시 조건식", markets: [], exclude: [], conditions: validConditions };
  expect(isScreen(validScreen)).toBe(true);
  expect(user.putScreens({ screens: [validScreen], revision: 1 }).status).toBe(200);

  const invalidConditions: unknown[] = [
    { kind: "program_net_buy", days: 0, minMillionWon: 100, maxMillionWon: null },
    { kind: "program_net_buy", days: 61, minMillionWon: 100, maxMillionWon: null },
    { kind: "program_net_buy", days: 5, minMillionWon: null, maxMillionWon: null },
    { kind: "program_net_buy", days: 5, minMillionWon: 500, maxMillionWon: 100 },
    { kind: "whale_net_buy", days: 5, minMillionWon: null, maxMillionWon: null },
    { kind: "whale_net_buy", days: 0, minMillionWon: 100, maxMillionWon: null },
    { kind: "vi_triggered", days: 5, minCount: 0 },
    { kind: "vi_triggered", days: 61, minCount: 1 },
  ];
  for (const bad of invalidConditions) {
    const badScreen = { id: "s-bad", name: "잘못된 미시", markets: [], exclude: [], conditions: [bad] };
    expect(isScreen(badScreen)).toBe(false);
    expect(user.putScreens({ screens: [badScreen], revision: 2 }).status).toBe(400);
  }
});
