import { expect, test } from "vitest";
import { arrangementKeyCommand, type ArrangementKeyEvent, type ArrangementKeyScene } from "./useArrangementKeys";

const press = (code: string, mods: Partial<ArrangementKeyEvent> = {}): ArrangementKeyEvent => ({ code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, ...mods });
const open: ArrangementKeyScene = { ownsKeyboard: false, wizardShown: false, dialogOpen: false, typing: false, desktop: true, inChartCell: false, gestureRunning: false };

test("Ctrl+Z·⌘+Z는 되돌리기, Ctrl+Shift+Z·Ctrl+Y는 다시 하기다", () => {
  expect(arrangementKeyCommand(press("KeyZ"), open)).toBe("undo");
  expect(arrangementKeyCommand(press("KeyZ", { ctrlKey: false, metaKey: true }), open)).toBe("undo");
  expect(arrangementKeyCommand(press("KeyZ", { shiftKey: true }), open)).toBe("redo");
  expect(arrangementKeyCommand(press("KeyY"), open)).toBe("redo");
});

test("Ctrl 없이, Alt와 함께, Ctrl+Shift+Y, 다른 글쇠는 처리하지 않는다", () => {
  expect(arrangementKeyCommand(press("KeyZ", { ctrlKey: false }), open)).toBeNull();
  expect(arrangementKeyCommand(press("KeyZ", { altKey: true }), open)).toBeNull();
  expect(arrangementKeyCommand(press("KeyY", { shiftKey: true }), open)).toBeNull();
  expect(arrangementKeyCommand(press("KeyX"), open)).toBeNull();
});

test.each<[string, Partial<ArrangementKeyScene>, Partial<ArrangementKeyEvent>]>([
  ["입력 칸", { typing: true }, {}],
  ["차트 칸 안", { inChartCell: true }, {}],
  ["대화상자", { dialogOpen: true }, {}],
  ["설정 마법사", { wizardShown: true }, {}],
  ["열린 메뉴·팝오버", { ownsKeyboard: true }, {}],
  ["휴대폰 폭", { desktop: false }, {}],
  ["끄는 중", { gestureRunning: true }, {}],
  ["조합 중", {}, { isComposing: true }],
  ["이미 처리됨", {}, { defaultPrevented: true }],
])("%s에서는 되돌리기와 다시 하기를 처리하지 않는다", (_name, scene, event) => {
  for (const code of ["KeyZ", "KeyY"]) expect(arrangementKeyCommand(press(code, event), { ...open, ...scene })).toBeNull();
  expect(arrangementKeyCommand(press("KeyZ", { ...event, shiftKey: true }), { ...open, ...scene })).toBeNull();
});
