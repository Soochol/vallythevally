import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { mountLayer } from "../overlay/topLayer";
import { useWizardStore } from "../setup-wizard/wizardOpen";
import { isWorkspaceTabKey, shouldBlockWorkspaceTab, workspaceTabScene, type WorkspaceTabEvent, type WorkspaceTabScene } from "./useWorkspaceTabGuard";

class FakeNode {
  parentElement: FakeElement | null = null;
  readonly children: FakeNode[] = [];
  append(child: FakeNode) {
    child.parentElement = this as unknown as FakeElement;
    this.children.push(child);
    return child;
  }
  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

class FakeElement extends FakeNode {
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = { left: "", top: "", maxHeight: "", removeProperty: () => {} };
  openPopover = false;
  isConnected = true;
  constructor(attrs: Record<string, string> = {}) {
    super();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  showPopover() { this.openPopover = true; }
  hidePopover() { this.openPopover = false; }
  matches(selector: string) {
    if (selector === ":popover-open") return this.openPopover;
    if (selector === "[popover]:popover-open") return this.attrs.has("popover") && this.openPopover;
    if (selector === '[role="dialog"], [role="alertdialog"]') {
      const role = this.attrs.get("role");
      return role === "dialog" || role === "alertdialog";
    }
    return false;
  }
  closest(selector: string): FakeElement | null {
    for (let cur: FakeElement | null = this; cur; cur = cur.parentElement) {
      if (cur.matches(selector)) return cur;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }; }
  querySelector() { return null; }
  focus() {}
}

class FakeObserver {
  observe() {}
  disconnect() {}
}

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

let desktopMatches = true;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  desktopMatches = true;
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("ResizeObserver", FakeObserver);
  vi.stubGlobal("MutationObserver", FakeObserver);
  vi.stubGlobal("matchMedia", () => ({ matches: desktopMatches }));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("document", { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} });
  useSelectionStore.setState({ dialog: null });
  useWizardStore.setState({ open: false });
  useAccountStore.setState({ status: null });
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  useSelectionStore.setState({ dialog: null });
  useWizardStore.setState({ open: false });
  useAccountStore.setState({ status: null });
  vi.unstubAllGlobals();
});

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

test("드로잉 스타일 막대와 알림처럼 닫히지 않는 popover 안에서도 Tab을 막는다", () => {
  const toolbar = new FakeElement({ role: "toolbar" });
  const widthButton = toolbar.append(new FakeElement()) as FakeElement;
  cleanups.push(mountLayer(toolbar as unknown as HTMLElement, { dismiss: false, blockChartKeys: false, focus: false, restoreFocus: false, onClose: () => {} }));

  const toastStack = new FakeElement();
  const undoButton = toastStack.append(new FakeElement()) as FakeElement;
  cleanups.push(mountLayer(toastStack as unknown as HTMLElement, { dismiss: false, blockChartKeys: false, focus: false, restoreFocus: false, onClose: () => {} }));

  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: widthButton as unknown as EventTarget }))).toBe(true);
  expect(shouldBlockWorkspaceTab(press("Tab", { shiftKey: true }), workspaceTabScene({ target: undoButton as unknown as EventTarget }))).toBe(true);
});

test("열린 메뉴·팝오버 층과 조건 편집 창 안에서는 Tab을 허용하고 닫히면 다시 막는다", () => {
  const outsideButton = new FakeElement();
  const menu = new FakeElement({ role: "menu" });
  const menuItem = menu.append(new FakeElement()) as FakeElement;
  const unmountMenu = mountLayer(menu as unknown as HTMLElement, { focus: false, restoreFocus: false, onClose: () => {} });
  cleanups.push(unmountMenu);

  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: menuItem as unknown as EventTarget }))).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: outsideButton as unknown as EventTarget }))).toBe(false);
  unmountMenu();
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: outsideButton as unknown as EventTarget }))).toBe(true);

  const editor = new FakeElement({ role: "dialog" });
  const editorInput = editor.append(new FakeElement()) as FakeElement;
  cleanups.push(mountLayer(editor as unknown as HTMLElement, { blockChartKeys: false, focus: false, restoreFocus: false, onClose: () => {} }));
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: editorInput as unknown as EventTarget }))).toBe(false);
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: outsideButton as unknown as EventTarget }))).toBe(true);
});

test("실제 스토어 상태와 대화상자 조상·휴대폰 폭에서 sceneOf가 예외를 가린다", () => {
  const button = new FakeElement();
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: button as unknown as EventTarget }))).toBe(true);

  useSelectionStore.setState({ dialog: { kind: "system-settings", menu: "kiwoom" } });
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: button as unknown as EventTarget }))).toBe(false);
  useSelectionStore.setState({ dialog: null });

  useAccountStore.setState({ status: { state: "signed_in", provider: "google", accountId: "a", signedInAt: 1, sync: { state: "running", lastSuccessAt: 1, pendingDocuments: 0, refusedDocuments: 0, lastError: null } } });
  useWizardStore.setState({ open: true });
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: button as unknown as EventTarget }))).toBe(false);
  useWizardStore.setState({ open: false });

  const dialog = new FakeElement({ role: "dialog" });
  const inner = dialog.append(new FakeElement()) as FakeElement;
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: inner as unknown as EventTarget }))).toBe(false);

  desktopMatches = false;
  expect(shouldBlockWorkspaceTab(press("Tab"), workspaceTabScene({ target: button as unknown as EventTarget }))).toBe(false);
});
