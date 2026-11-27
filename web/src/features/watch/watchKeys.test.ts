import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AccountStatus } from "../../api/generated/AccountStatus";
import type { Watchlist } from "../../api/generated/Watchlist";
import { rowKey } from "../../lib/watchlist";
import { windowId } from "../../layout/kinds";
import { useAccountStore } from "../../stores/account";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useWizardStore } from "../setup-wizard/wizardOpen";
import { createRowPreviewStore, nextWatchRow, resolveWatchRow, visibleWatchRows, type WatchKeyEvent, watchKeyStep } from "./watchKeys";

class KeyTarget extends EventTarget {
  constructor(
    readonly tagName = "BUTTON",
    private readonly matched: readonly string[] = [],
    readonly isContentEditable = false,
  ) {
    super();
  }

  closest(selector: string) {
    const selectors = selector.split(",").map((part) => part.trim());
    return selectors.some((part) => this.matched.includes(part)) ? this : null;
  }
}

const key = (patch: Partial<WatchKeyEvent> = {}): WatchKeyEvent => ({
  key: "ArrowDown",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
  repeat: false,
  target: new KeyTarget(),
  preventDefault: vi.fn(),
  ...patch,
});

beforeEach(() => {
  vi.stubGlobal("HTMLElement", KeyTarget);
  vi.stubGlobal("Element", KeyTarget);
  useSelectionStore.setState({ dialog: null });
  useAccountStore.setState({ status: null });
  useWizardStore.setState({ open: false });
});

afterEach(() => {
  useAccountStore.setState({ status: null });
  useWizardStore.setState({ open: false });
  vi.unstubAllGlobals();
});

test("접힌 그룹의 종목을 빼고 화면 순서대로 줄 목록을 만든다", () => {
  const list: Watchlist = {
    id: "L",
    name: "기본",
    symbols: ["005930", "086520", "005935", "000660"],
    groups: [
      { id: "g1", name: "첫째", symbols: ["005930", "086520"] },
      { id: "g2", name: "둘째", symbols: ["086520", "005935"] },
    ],
  };
  expect(visibleWatchRows(list, [])).toEqual([
    { code: "005930", groupId: "g1" },
    { code: "086520", groupId: "g1" },
    { code: "086520", groupId: "g2" },
    { code: "005935", groupId: "g2" },
    { code: "000660", groupId: null },
  ]);
  expect(visibleWatchRows(list, ["g2"])).toEqual([
    { code: "005930", groupId: "g1" },
    { code: "086520", groupId: "g1" },
    { code: "000660", groupId: null },
  ]);
});

test("다음 줄 계산은 초점 줄·첫 줄·미리보기 줄과 양 끝 멈춤 규칙을 따른다", () => {
  const rows = [
    { code: "005930", groupId: "g1" },
    { code: "086520", groupId: "g1" },
    { code: "086520", groupId: "g2" },
    { code: "005935", groupId: "g2" },
  ];
  expect(nextWatchRow(rows, 1, { previewKey: null, watched: "000660", focusedKey: null })).toEqual(rows[0]);
  expect(nextWatchRow(rows, -1, { previewKey: null, watched: "000660", focusedKey: null })).toEqual(rows[3]);
  expect(nextWatchRow(rows, 1, { previewKey: null, watched: "086520", focusedKey: null })).toEqual(rows[2]);
  expect(nextWatchRow(rows, 1, { previewKey: null, watched: "086520", focusedKey: rowKey(rows[2]!) })).toEqual(rows[3]);
  expect(nextWatchRow(rows, -1, { previewKey: null, watched: "005930", focusedKey: null })).toBeNull();
  expect(nextWatchRow(rows, 1, { previewKey: null, watched: "005935", focusedKey: null })).toBeNull();
  expect(nextWatchRow(rows, 1, { previewKey: rowKey(rows[1]!), watched: "005930", focusedKey: null })).toEqual(rows[2]);
  expect(nextWatchRow([], 1, { previewKey: null, watched: "005930", focusedKey: null })).toBeNull();
});

test("보조 키·입력칸·열린 메뉴·대화상자·이미 처리된 키는 쓰지 않는다", () => {
  expect(watchKeyStep(key({ key: "ArrowDown" }))).toBe(1);
  expect(watchKeyStep(key({ key: "ArrowUp" }))).toBe(-1);
  expect(watchKeyStep(key({ key: "ArrowLeft" }))).toBeNull();

  for (const patch of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { defaultPrevented: true },
    { target: new KeyTarget("INPUT") },
    { target: new KeyTarget("TEXTAREA") },
    { target: new KeyTarget("SELECT") },
    { target: new KeyTarget("DIV", [], true) },
    { target: new KeyTarget("BUTTON", ["[popover]:popover-open"]) },
    { target: new KeyTarget("BUTTON", ["[role=menu]"]) },
    { target: new KeyTarget("BUTTON", ["[role=dialog]"]) },
    { target: new KeyTarget("BUTTON", ["[role=alertdialog]"]) },
  ]) {
    expect(watchKeyStep(key(patch))).toBeNull();
  }

  useSelectionStore.getState().openSearch();
  expect(watchKeyStep(key())).toBeNull();
});

test("셋업 마법사가 보이는 동안에는 방향키를 쓰지 않는다", () => {
  const signedIn: AccountStatus = {
    state: "signed_in",
    provider: "google",
    accountId: "0123456789abcdef0123",
    signedInAt: 1_762_650_000,
    sync: { state: "running", lastSuccessAt: 1_762_650_000, pendingDocuments: 0, refusedDocuments: 0, lastError: null },
  };
  useAccountStore.setState({ status: signedIn });
  useWizardStore.getState().show();
  expect(watchKeyStep(key({ key: "ArrowDown" }))).toBeNull();
  expect(watchKeyStep(key({ key: "ArrowUp" }))).toBeNull();

  useWizardStore.getState().hide();
  expect(watchKeyStep(key({ key: "ArrowDown" }))).toBe(1);

  useAccountStore.setState({
    status: {
      ...signedIn,
      sync: { state: "needs_choice", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null, localDocuments: 1, accountDocuments: 1 },
    },
  });
  expect(watchKeyStep(key({ key: "ArrowDown" }))).toBeNull();
});

test("반복 미리보기 저장소는 줄 이동 때 떠난 줄과 새 줄 구독자만 깨운다", () => {
  const store = createRowPreviewStore();
  const calls = { a: 0, b: 0, c: 0, d: 0 };
  const unsubs = [
    store.subscribe("a", () => { calls.a += 1; }),
    store.subscribe("b", () => { calls.b += 1; }),
    store.subscribe("c", () => { calls.c += 1; }),
    store.subscribe("d", () => { calls.d += 1; }),
  ];

  store.set("b");
  expect(calls).toEqual({ a: 1, b: 1, c: 1, d: 1 });

  calls.a = calls.b = calls.c = calls.d = 0;
  store.set("c");
  expect(calls).toEqual({ a: 0, b: 1, c: 1, d: 0 });

  calls.a = calls.b = calls.c = calls.d = 0;
  store.set("c");
  expect(calls).toEqual({ a: 0, b: 0, c: 0, d: 0 });

  store.set(null);
  expect(calls).toEqual({ a: 1, b: 1, c: 1, d: 1 });

  for (const stop of unsubs) stop();
});

test("차트 없는 연동 색에 묶인 관심종목의 방향키 이동은 groupSymbols의 현재 종목을 기준으로 다음·이전 줄을 고른다", () => {
  const cell = windowId("cell-0");
  const watchlist = windowId("watchlist");
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useLayoutStore.getState().setSymbol(cell, { code: "005930" });
  useLayoutStore.getState().openWindow("program", undefined, { link: "c" });
  useLayoutStore.getState().setLink(watchlist, "c");
  useLayoutStore.getState().sendSymbol(watchlist, cell, { code: "086520" });
  useSelectionStore.setState({ activeCell: cell });

  const rows = [
    { code: "005930", groupId: null },
    { code: "086520", groupId: null },
    { code: "005935", groupId: null },
  ];
  expect(resolveWatchRow(watchlist, rows, 1, { previewKey: null, focusedKey: null })).toEqual(rows[2]);
  expect(resolveWatchRow(watchlist, rows, -1, { previewKey: null, focusedKey: null })).toEqual(rows[0]);
});
