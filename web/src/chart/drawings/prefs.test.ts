import { expect, test } from "vitest";
import { DEFAULT_DRAWING_PREFS, parseDrawingPrefs } from "./prefs";

const saved = { magnet: false, magnetStrength: "strong", keepDrawing: true, pinnedTools: ["trendline"], newScope: "cell" };

test("dockAt이 없는 저장값은 기본 자리로 읽고 다른 드로잉 설정은 그대로다", () => {
  const prefs = parseDrawingPrefs(saved);
  expect(prefs.dockAt).toBeNull();
  expect(prefs).toMatchObject(saved);
  expect(DEFAULT_DRAWING_PREFS.dockAt).toBeNull();
});

test.each([
  ["x가 문자열", { x: "0.5", y: 0.2 }],
  ["x가 범위 밖", { x: 1.2, y: 0.2 }],
  ["y가 음수", { x: 0.5, y: -0.1 }],
  ["x가 NaN", { x: Number.NaN, y: 0.2 }],
  ["y가 없음", { x: 0.5 }],
  ["배열", [0.5, 0.2]],
])("모양이 틀린 dockAt(%s)은 기본 자리로 읽고 다른 드로잉 설정은 그대로다", (_, dockAt) => {
  const prefs = parseDrawingPrefs({ ...saved, dockAt });
  expect(prefs.dockAt).toBeNull();
  expect(prefs).toMatchObject(saved);
});

test("0~1의 두 수인 dockAt은 그대로 읽는다", () => {
  expect(parseDrawingPrefs({ ...saved, dockAt: { x: 0, y: 1 } }).dockAt).toEqual({ x: 0, y: 1 });
  expect(parseDrawingPrefs({ ...saved, dockAt: { x: 0.25, y: 0.6, extra: 3 } }).dockAt).toEqual({ x: 0.25, y: 0.6 });
});
