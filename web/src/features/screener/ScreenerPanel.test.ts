import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { useSelectionStore } from "../../stores/selection";
import { handleResultKey, type ScreenerKeyEvent } from "./ScreenerPanel";
import { SentenceEditor } from "./SentenceEditor";
import { createScreenEditing } from "./screenEditing";

class KeyTarget extends EventTarget {
  constructor(readonly tagName = "BUTTON", readonly popover = false, readonly isContentEditable = false) { super(); }
  closest(selector: string) { return selector === "[popover]:popover-open" && this.popover ? this : null; }
}

const key = (patch: Partial<ScreenerKeyEvent> = {}): ScreenerKeyEvent => ({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, target: new KeyTarget(), preventDefault: vi.fn(), ...patch });
const callbacks = (onRun = vi.fn()) => ({ rows: [], active: "005930", onSelect: vi.fn(), onRun });

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

test("팝오버의 Ctrl+Enter와 ↓는 실행이나 결과 이동이 가져가지 않는다", () => {
  for (const patch of [{ ctrlKey: true }, { key: "ArrowDown" }]) {
    const event = key({ ...patch, target: new KeyTarget("BUTTON", true) });
    const actions = callbacks();
    handleResultKey(event, actions);
    expect(actions.onRun).not.toHaveBeenCalled();
    expect(actions.onSelect).not.toHaveBeenCalled();
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

async function editorMarkup(editing: boolean, invalid = false) {
  const source: Screen = { id: "s", name: "신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "W", field: "high", n: 52, recentBars: 5 }] };
  const base: Screens = { revision: 1, screens: [source] };
  const screenEditing = createScreenEditing({
    screens: { watch: (see) => see(base), load: async () => ({ kind: "ok", list: base }), put: async () => ({ kind: "error", message: "쓰지 않음" }) },
    runner: { runs: () => ({}), check: async () => ({ kind: "ready" }), run: async () => {} },
  });
  if (invalid) {
    screenEditing.edit((draft) => ({ ...draft, name: "" }));
    await screenEditing.run();
  }
  const { entries, chosen } = screenEditing.view();
  if (!chosen) throw new Error("문장 편집기에 보일 조건식이 있어야 합니다");
  const client = new QueryClient();
  const editor = createElement(SentenceEditor, { screenEditing, chosen, entries, blocked: false, resultActions: null, editing, onEditingChange: () => {}, onRun: () => {} });
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, editor));
  client.clear();
  return markup;
}

test("패널은 조건 요약과 실행·편집만 보이고 문장 편집은 편집 창에서 연다", async () => {
  const closed = await editorMarkup(false);
  expect(closed).toContain("52주 신고가");
  expect(closed).toContain("코스피 · ETF 제외");
  expect(closed).toContain('aria-haspopup="dialog" aria-expanded="false"');
  expect(closed).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  expect(closed).not.toContain('aria-label="문장형 조건식"');
  expect(closed).not.toContain('aria-label="조건 편집 창"');
  const open = await editorMarkup(true);
  expect(open).toContain('role="dialog" aria-label="조건 편집 창"');
  expect(open).toContain('aria-label="조건식 이름"');
  expect(open).toContain('aria-label="문장형 조건식"');
  expect(open).toContain('aria-keyshortcuts="Control+S Meta+S"');
  expect(open).toContain("닫아도 편집 내용은 남습니다");
  expect(open).toContain('aria-haspopup="dialog" aria-expanded="true"');
  expect([...open.matchAll(/>저장</g)]).toHaveLength(1);
});

test("검증에 실패하면 닫힌 패널과 편집 창에 오류를 한 번씩 보인다", async () => {
  const closed = await editorMarkup(false, true);
  expect([...closed.matchAll(/이름을 넣으세요/g)]).toHaveLength(1);
  expect(closed).not.toContain('aria-label="문장형 조건식"');
  const open = await editorMarkup(true, true);
  expect([...open.matchAll(/이름을 넣으세요/g)]).toHaveLength(1);
  expect(open).toContain('aria-label="조건식 이름" aria-invalid="true"');
});
