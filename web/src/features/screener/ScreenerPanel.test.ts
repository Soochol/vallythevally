import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { useSelectionStore } from "../../stores/selection";
import { handleResultKey, type ScreenerKeyEvent } from "./ScreenerPanel";
import { SentenceEditor } from "./SentenceEditor";
import { createWorkspace } from "./workspace";

class KeyTarget extends EventTarget {
  constructor(readonly tagName = "BUTTON", readonly popover = false, readonly isContentEditable = false) { super(); }
  closest(selector: string) { return selector === "[popover]:popover-open" && this.popover ? this : null; }
}

const key = (patch: Partial<ScreenerKeyEvent> = {}): ScreenerKeyEvent => ({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target: new KeyTarget(), preventDefault: vi.fn(), ...patch });
const callbacks = (onRun = vi.fn()) => ({ rows: [], active: null, wide: false, onSelect: vi.fn(), onOpen: vi.fn(), onRun });

beforeEach(() => {
  vi.stubGlobal("HTMLElement", KeyTarget);
  vi.stubGlobal("Element", KeyTarget);
  useSelectionStore.setState({ dialog: null });
});
afterEach(() => vi.unstubAllGlobals());

test("결과 영역의 Ctrl+Enter와 Meta+Enter는 실행을 한 번 부르고 기본 동작을 막는다", () => {
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const event = key(modifiers);
    const actions = callbacks();
    handleResultKey(event, actions);
    expect(actions.onRun).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
});

test("팝오버의 Enter와 Ctrl+Enter는 결과 열기나 실행이 가져가지 않는다", () => {
  for (const ctrlKey of [false, true]) {
    const event = key({ ctrlKey, target: new KeyTarget("BUTTON", true) });
    const actions = { ...callbacks(), wide: true };
    handleResultKey(event, actions);
    expect(actions.onRun).not.toHaveBeenCalled();
    expect(actions.onOpen).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
});

test("텍스트 입력과 조합 중 입력·검색 창은 자신의 키를 유지한다", () => {
  for (const target of [new KeyTarget("INPUT"), new KeyTarget("TEXTAREA"), new KeyTarget("DIV", false, true)]) {
    const event = key({ ctrlKey: true, target });
    const actions = callbacks();
    handleResultKey(event, actions);
    expect(actions.onRun).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  }
  for (const patch of [{ isComposing: true }, { defaultPrevented: true }]) {
    const event = key({ ctrlKey: true, ...patch });
    const actions = callbacks();
    handleResultKey(event, actions);
    expect(actions.onRun).not.toHaveBeenCalled();
  }
  useSelectionStore.getState().openSearch();
  const actions = callbacks();
  handleResultKey(key({ ctrlKey: true }), actions);
  expect(actions.onRun).not.toHaveBeenCalled();
});
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function editorMarkup(wide: boolean, expanded: boolean, invalid = false) {
  const source: Screen = { id: "s", name: "신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "W", field: "high", n: 52, recentBars: 5 }] };
  const base: Screens = { revision: 1, screens: [source] };
  const workspace = createWorkspace({ screens: { load: async () => base, put: async () => ({ kind: "error", message: "쓰지 않음" }) }, runner: { runs: () => ({}), run: async () => {} } });
  await workspace.load();
  if (invalid) {
    workspace.edit((draft) => ({ ...draft, name: "" }));
    await workspace.run(false);
  }
  const { entries, chosen } = workspace.view();
  if (!chosen?.draft) throw new Error("문장 편집기에 보일 초안이 있어야 합니다");
  const client = new QueryClient();
  const editor = createElement(SentenceEditor, { workspace, chosen, draft: chosen.draft, entries, blocked: false, resultActions: null, wide, expanded, onExpandedChange: () => {}, onRun: () => {} });
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, editor));
  client.clear();
  return markup;
}

test("넓게 보기는 조건 요약에서 문장 편집을 펼치고 오른쪽 탭은 바로 편집한다", async () => {
  const collapsed = await editorMarkup(true, false);
  expect(collapsed).toContain("조건 펼치기");
  expect(collapsed).toContain("52주 신고가");
  expect(collapsed).not.toContain('aria-label="문장형 조건식"');
  expect(collapsed).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  const expanded = await editorMarkup(true, true);
  expect(expanded).toContain("조건 접기");
  expect(expanded).toContain('aria-label="문장형 조건식"');
  expect(await editorMarkup(false, false)).toContain('aria-label="문장형 조건식"');
});

test("접힌 넓게 보기에서 검증에 실패하면 오류와 조건 편집을 함께 보인다", async () => {
  const invalid = await editorMarkup(true, false, true);
  expect(invalid).toContain("이름을 넣으세요");
  expect(invalid).toContain('aria-label="문장형 조건식"');
});
