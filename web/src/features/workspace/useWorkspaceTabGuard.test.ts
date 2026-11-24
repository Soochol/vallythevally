import { expect, test } from "vitest";
import { isWorkspaceTabKey, shouldBlockWorkspaceTab, type WorkspaceTabEvent, type WorkspaceTabScene } from "./useWorkspaceTabGuard";

const press = (key: string, mods: Partial<WorkspaceTabEvent> = {}): WorkspaceTabEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  keyCode: key === "Tab" ? 9 : 0,
  ...mods,
});

const workspace: WorkspaceTabScene = {
  ownsKeyboard: false,
  wizardShown: false,
  dialogOpen: false,
  inDialog: false,
  desktop: true,
};

test("작업 화면에서는 Tab과 Shift+Tab을 막는다", () => {
  expect(shouldBlockWorkspaceTab(press("Tab"), workspace)).toBe(true);
  expect(shouldBlockWorkspaceTab(press("Tab", { shiftKey: true }), workspace)).toBe(true);
});

test("Tab이 아닌 키와 조합·보조키가 붙은 Tab은 건드리지 않는다", () => {
  for (const key of ["Enter", "Escape", "ArrowDown", "a", "F10"]) expect(isWorkspaceTabKey(press(key))).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { ctrlKey: true }), workspace)).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { metaKey: true }), workspace)).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { altKey: true }), workspace)).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { isComposing: true }), workspace)).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { keyCode: 229 }), workspace)).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { defaultPrevented: true }), workspace)).toBe(false);
});

test.each<[string, Partial<WorkspaceTabScene>]>([
  ["열린 메뉴·팝오버", { ownsKeyboard: true }],
  ["설정 마법사", { wizardShown: true }],
  ["열린 대화상자 상태", { dialogOpen: true }],
  ["대화상자 안 요소", { inDialog: true }],
  ["휴대폰 폭", { desktop: false }],
])("%s에서는 Tab을 막지 않는다", (_name, override) => {
  expect(shouldBlockWorkspaceTab(press("Tab"), { ...workspace, ...override })).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab", { shiftKey: true }), { ...workspace, ...override })).toBe(false);
});
