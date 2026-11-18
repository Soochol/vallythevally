import { expect, test } from "vitest";
import { DEFAULT_DRAWING_PREFS, parseDrawingPrefs } from "./prefs";

const saved = { magnet: false, magnetStrength: "strong", keepDrawing: true, pinnedTools: ["trendline"], newScope: "cell" };

test("toolbarHidden이 없는 저장값은 막대를 보이는 것으로 읽고 다른 드로잉 설정은 그대로다", () => {
  const prefs = parseDrawingPrefs(saved);
  expect(prefs.toolbarHidden).toBe(false);
  expect(prefs).toMatchObject(saved);
  expect(DEFAULT_DRAWING_PREFS.toolbarHidden).toBe(false);
});

test("저장한 toolbarHidden은 그대로 읽고 불리언이 아니면 보이는 것으로 읽는다", () => {
  expect(parseDrawingPrefs({ ...saved, toolbarHidden: true }).toolbarHidden).toBe(true);
  expect(parseDrawingPrefs({ ...saved, toolbarHidden: "yes" }).toolbarHidden).toBe(false);
});

test.each([
  ["옛 비율 자리", { x: 0.8, y: 0.8 }],
  ["모양이 틀린 값", "left"],
  ["null", null],
])("옛 설정의 dockAt(%s)은 읽기를 실패시키지 않고 결과에서 빠진다", (_, dockAt) => {
  const prefs = parseDrawingPrefs({ ...saved, dockAt });
  expect(prefs).toMatchObject(saved);
  expect(prefs).not.toHaveProperty("dockAt");
});
