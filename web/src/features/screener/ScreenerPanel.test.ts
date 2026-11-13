import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { checkedSession, currentSession, sessionOf, useScreenEditor } from "./editorState";
import { handleResultKey, type ScreenerKeyEvent } from "./ScreenerPanel";
import { SentenceEditor } from "./SentenceEditor";

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
  useScreenEditor.setState({ sessions: {} });
  useScreenerStore.setState({ runs: {} });
});
afterEach(() => vi.unstubAllGlobals());

test("문장 편집의 Ctrl+Enter와 Meta+Enter는 현재 검증된 draft를 실행한다", async () => {
  const source: Screen = { id: "s", name: "저장한 식", markets: [], exclude: [], conditions: [] };
  const base: Screens = { revision: 1, screens: [source] };
  useScreenEditor.getState().change(base, source, (draft) => ({ ...draft, name: "지금 편집 중", markets: ["kosdaq"] }));
  const sent: Screen[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ rows: [] })); }));
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const session = currentSession(base, source, useScreenEditor.getState().sessions);
    const checked = checkedSession(session, base);
    if (!checked.ok) throw new Error("검증된 draft여야 합니다");
    const event = key(modifiers);
    const run = vi.fn(() => useScreenerStore.getState().run(checked.screen));
    handleResultKey(event, callbacks(run));
    expect(run).toHaveBeenCalledOnce();
    await run.mock.results[0]?.value;
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  expect(sent).toEqual(Array.from({ length: 2 }, () => ({ ...source, name: "지금 편집 중", markets: ["kosdaq"] })));
  expect(source.name).toBe("저장한 식");
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

function editorMarkup(wide: boolean, editing: boolean, invalid = false) {
  const source: Screen = { id: "s", name: "신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "W", field: "high", n: 52, recentBars: 5 }] };
  const base: Screens = { revision: 1, screens: [source] };
  const session = sessionOf(base, source);
  const client = new QueryClient();
  const editor = createElement(SentenceEditor, { session: invalid ? { ...session, draft: { ...session.draft, name: "" }, tried: true } : session, base, source, running: false, blocked: false, resultActions: null, wide, editing, onEditingChange: () => {}, onRun: () => {} });
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, editor));
  client.clear();
  return markup;
}

test("오른쪽 탭은 조건 요약과 실행·편집만 보이고 문장 편집은 편집 창에서 연다", () => {
  const closed = editorMarkup(false, false);
  expect(closed).toContain("52주 신고가");
  expect(closed).toContain("코스피 · ETF 제외");
  expect(closed).toContain('aria-haspopup="dialog" aria-expanded="false"');
  expect(closed).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  expect(closed).not.toContain('aria-label="문장형 조건식"');
  expect(closed).not.toContain('aria-label="조건 편집 창"');
  expect(closed).not.toContain("조건 펼치기");
  const open = editorMarkup(false, true);
  expect(open).toContain('role="dialog" aria-label="조건 편집 창"');
  expect(open).toContain('aria-label="조건식 이름"');
  expect(open).toContain('aria-label="문장형 조건식"');
  expect(open).toContain('aria-keyshortcuts="Control+S Meta+S"');
  expect(open).toContain("닫아도 편집 내용은 남습니다");
  expect(open).toContain('aria-haspopup="dialog" aria-expanded="true"');
  expect([...open.matchAll(/>저장</g)]).toHaveLength(1);
});

test("넓게 보기는 조건 요약에서 문장 편집을 그 자리에 펼치고 편집 창을 쓰지 않는다", () => {
  const collapsed = editorMarkup(true, false);
  expect(collapsed).toContain("조건 펼치기");
  expect(collapsed).toContain("52주 신고가");
  expect(collapsed).not.toContain('aria-label="문장형 조건식"');
  expect(collapsed).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  const expanded = editorMarkup(true, true);
  expect(expanded).toContain("조건 접기");
  expect(expanded).toContain('aria-label="문장형 조건식"');
  expect(expanded).not.toContain('aria-label="조건 편집 창"');
  expect(expanded).not.toContain("편집</button>");
});

test("검증에 실패하면 넓게 보기는 조건 편집을 펼치고 오른쪽 탭은 닫힌 패널과 편집 창에 오류를 한 번씩 보인다", () => {
  const wide = editorMarkup(true, false, true);
  expect(wide).toContain("이름을 넣으세요");
  expect(wide).toContain('aria-label="문장형 조건식"');
  const closed = editorMarkup(false, false, true);
  expect([...closed.matchAll(/이름을 넣으세요/g)]).toHaveLength(1);
  expect(closed).not.toContain('aria-label="문장형 조건식"');
  const open = editorMarkup(false, true, true);
  expect([...open.matchAll(/이름을 넣으세요/g)]).toHaveLength(1);
  expect(open).toContain('aria-label="조건식 이름" aria-invalid="true"');
});
