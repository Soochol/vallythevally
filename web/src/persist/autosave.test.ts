import type { Layout } from "../api/generated/Layout";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { windowId, type WindowId } from "../layout/kinds";
import type { Rect } from "../layout/placement";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../stores/layout";
import { usePersistStore } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { type Autosave, commitWatchlist, RECENT_CLEARED, startAutosave } from "./autosave";
import { createLayoutReceipt, type LayoutReceiptRecorder, type ReceiptChange } from "./layoutReceipt";
import { PAYLOAD_LIMIT_BYTES } from "./bytes";
import { ApiRequestError } from "../api/http";
import { restore } from "./restore";
import { DEFAULT_UI_PREFS, toUiState } from "./uiState";
import { FIRST_WATCHLIST_ID, MAX_WATCHLIST_NAME, MAX_WATCHLISTS } from "../lib/watchlist";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const [CHART, ...OTHER_WINDOWS] = DEFAULT_LAYOUT.windows;
const FIRST = { id: FIRST_WATCHLIST_ID, name: "기본", groups: [] };

let autosave: Autosave;
let puts: { path: string; body: unknown; keepalive: boolean }[];
let toasts: string[];
let receipt: LayoutReceiptRecorder;
const holds = (id: string) => receipt.holds(DEFAULT_LAYOUT.id, id);

beforeEach(() => {
  vi.useFakeTimers();
  puts = [];
  toasts = [];
  receipt = createLayoutReceipt();
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, lastLayoutId: DEFAULT_LAYOUT.id, recentSymbols: ["IDX:001"] }, { phone: 1 });
  useWatchlistStore.getState().load([{ ...FIRST, symbols: ["005930"] }]);
  autosave = startAutosave({
    put: async (path, json, { keepalive }) => {
      puts.push({ path, body: JSON.parse(json), keepalive });
    },
    toast: (t) => toasts.push(t),
    revisions: { layout: 0, ui: 0, watchlist: 0 },
    unsaved: () => undefined,
    receipt,
  });
});

afterEach(() => {
  autosave.stop();
  vi.useRealTimers();
});

test("복원한 값을 싣기만 하면 아무것도 보내지 않는다", async () => {
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  useUiStore.getState().pushRecent("IDX:001"); // 첫 칸의 종목은 이미 맨 앞이다
  useLayoutStore.getState().setPeriod(CELL, "D");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(puts).toEqual([]);
});

test("칸을 바꾸면 1초 뒤 레이아웃을 통째로 보내고 저장됨이 된다", async () => {
  useLayoutStore.getState().setPeriod(CELL, "W");
  useLayoutStore.getState().setStyle(CELL, "line");
  await vi.advanceTimersByTimeAsync(999);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.layout).toEqual({ kind: "pending" });
  await vi.advanceTimersByTimeAsync(1);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.path).toBe(`/api/layouts/${DEFAULT_LAYOUT.id}`);
  expect(puts[0]!.body).toEqual({
    id: DEFAULT_LAYOUT.id,
    name: DEFAULT_LAYOUT.name,
    sync: DEFAULT_LAYOUT.sync,
    windows: [{ ...CHART, venue: null, period: "W", chartSettings: { ...chartWindows(DEFAULT_LAYOUT)[0]!.chartSettings, style: "line" } }, ...OTHER_WINDOWS],
    placement: { v: 1, dock: null, canvas: null },
    revision: expect.any(Number),
  });
  expect(puts[0]!.body).not.toHaveProperty("updatedAt");
  expect(usePersistStore.getState().saves.layout.kind).toBe("saved");
});

test("차트 창을 더하면 기다리지 않고 레이아웃을 보내고, 다른 창을 더하거나 닫으면 1초 뒤에 보낸다", async () => {
  useLayoutStore.getState().showWindow("indicators");
  useLayoutStore.getState().closeWindow(windowId("screener"));
  await vi.advanceTimersByTimeAsync(999);
  expect(puts).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(puts).toHaveLength(1);
  const id = useLayoutStore.getState().addChart(CELL, null)!;
  await vi.advanceTimersByTimeAsync(0);
  expect(puts).toHaveLength(2);
  expect((puts[1]!.body as { windows: { id: string }[] }).windows.map((w) => w.id)).toContain(id);
});

test("서버가 가진 차트 창은 보낸 레이아웃이 성공한 뒤에 바뀌고, 보내는 중인 본문에 없는 창은 서버에 없을 수 있다", async () => {
  autosave.stop();
  let finish = () => {};
  autosave = startAutosave({
    put: (path, json, { keepalive }) => { puts.push({ path, body: JSON.parse(json), keepalive }); return new Promise<void>((resolve) => { finish = resolve; }); },
    toast: (t) => toasts.push(t),
    revisions: { layout: 0, ui: 0, watchlist: 0 },
    serverCharts: [CELL],
    unsaved: () => undefined,
    receipt,
  });
  expect(holds(CELL)).toBe(false);
  const id = useLayoutStore.getState().addChart(CELL, null)!;
  expect(holds(id)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(puts).toHaveLength(1);
  expect(holds(id)).toBe(true);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(holds(id)).toBe(false);
  useLayoutStore.getState().closeWindow(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toHaveLength(2);
  expect(holds(id)).toBe(true);
  expect(holds(CELL)).toBe(false);
});

test("결과를 모르는 레이아웃 저장 뒤에는 보낸 본문에 없던 차트 창도 서버에 없을 수 있고, stale이면 모두 모른다", async () => {
  autosave.stop();
  const second = windowId("second");
  const layout = useLayoutStore.getState().layout;
  useLayoutStore.getState().load({ ...layout, windows: [...layout.windows, { ...chartWindows(layout)[0]!, id: second }] });
  let reply: () => Promise<void> = async () => { throw new TypeError("connection reset"); };
  autosave = startAutosave({
    put: (path, json, { keepalive }) => { puts.push({ path, body: JSON.parse(json), keepalive }); return reply(); },
    toast: (t) => toasts.push(t),
    revisions: { layout: 0, ui: 0, watchlist: 0 },
    serverCharts: [CELL, second],
    unsaved: () => undefined,
    receipt,
  });
  expect(holds(second)).toBe(false);
  useLayoutStore.getState().closeWindow(second);
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toHaveLength(1);
  useLayoutStore.getState().load({ ...layout, windows: [...layout.windows, { ...chartWindows(layout)[0]!, id: second }] });
  expect(holds(second)).toBe(true);
  expect(holds(CELL)).toBe(false);
  reply = async () => { throw new ApiRequestError("stale_revision", "더 새 편집"); };
  useLayoutStore.getState().setPeriod(CELL, "M");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(holds(CELL)).toBe(true);
});

test("이미 확정된 레이아웃보다 오래된 요청의 응답은 성공이든 stale이든 서버 차트 창을 바꾸지 않는다", async () => {
  autosave.stop();
  const second = windowId("second");
  const replies: { resolve(): void; reject(e: unknown): void }[] = [];
  autosave = startAutosave({
    put: (path, json, { keepalive }) => {
      puts.push({ path, body: JSON.parse(json), keepalive });
      return new Promise<void>((resolve, reject) => { replies.push({ resolve, reject }); });
    },
    toast: (t) => toasts.push(t),
    revisions: { layout: 0, ui: 0, watchlist: 0 },
    serverCharts: [CELL, second],
    unsaved: () => undefined,
    receipt,
  });
  const layout = useLayoutStore.getState().layout;
  useLayoutStore.getState().load({ ...layout, windows: [...layout.windows, { ...chartWindows(layout)[0]!, id: second }] });
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  useLayoutStore.getState().closeWindow(second);
  autosave.flush();
  expect(puts).toHaveLength(2);
  replies[1]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(holds(second)).toBe(true);
  replies[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(holds(second)).toBe(true);
  expect(holds(CELL)).toBe(false);

  useLayoutStore.getState().setPeriod(CELL, "M");
  await vi.advanceTimersByTimeAsync(1000);
  useLayoutStore.getState().setPeriod(CELL, "D");
  autosave.flush();
  expect(puts).toHaveLength(4);
  replies[3]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  replies[2]!.reject(new ApiRequestError("stale_revision", "더 새 편집"));
  await vi.advanceTimersByTimeAsync(0);
  expect(holds(CELL)).toBe(false);
});

test("표시 뒤에 보낸 레이아웃 본문에 차트 창이 빠졌는지 알려 준다", async () => {
  const id = useLayoutStore.getState().addChart(CELL, null)!;
  await vi.advanceTimersByTimeAsync(0);
  const mark = receipt.mark();
  expect(receipt.droppedSince(id, mark)).toBe(false);
  useLayoutStore.getState().closeWindow(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(receipt.droppedSince(id, mark)).toBe(true);
  expect(receipt.droppedSince(CELL, mark)).toBe(false);
  expect(receipt.droppedSince(id, receipt.mark())).toBe(false);
});

test("레이아웃 저장이 실패하면 확인 port가 실패를 알리고 다시 저장되면 풀린다", async () => {
  autosave.stop();
  let reply: () => Promise<void> = async () => { throw new ApiRequestError("bad_request", "거절"); };
  autosave = startAutosave({
    put: (path, json, { keepalive }) => { puts.push({ path, body: JSON.parse(json), keepalive }); return reply(); },
    toast: (t) => toasts.push(t),
    revisions: { layout: 0, ui: 0, watchlist: 0 },
    serverCharts: [CELL],
    unsaved: () => undefined,
    receipt,
  });
  const changes: ReceiptChange[] = [];
  receipt.subscribe((change) => changes.push(change));
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  expect(usePersistStore.getState().saves.layout.kind).toBe("failed");
  expect(receipt.failed()).toBe(true);
  expect(changes).toContain("changed");
  reply = async () => {};
  autosave.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(receipt.failed()).toBe(false);
  expect(changes.at(-1)).toBe("saved");
});

test("확인 port는 지금 레이아웃의 차트 창을 알려 주고 다른 레이아웃의 칸은 기다리게 하지 않는다", () => {
  expect(receipt.current()).toEqual({ id: DEFAULT_LAYOUT.id, charts: new Set([CELL]) });
  expect(receipt.holds("other", "anything")).toBe(false);
});

test("자동 저장이 멈추면 확인 port는 모든 칸 드로잉을 기다리게 한다", () => {
  const changes: ReceiptChange[] = [];
  receipt.subscribe((change) => changes.push(change));
  autosave.stop();
  expect(receipt.current()).toBeNull();
  expect(receipt.holds("other", CELL)).toBe(true);
  expect(changes).toEqual(["changed"]);
});

test("UI 설정을 바꾸면 모르는 키와 함께 UiState를 보낸다", async () => {
  useUiStore.getState().setIndicatorWindow("inspector");
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toEqual([
    {
      path: "/api/ui-state",
      body: {
        phone: 1,
        lastLayoutId: DEFAULT_LAYOUT.id,
        theme: "dark",
        recentSymbols: ["IDX:001"],
        activeWatchlistId: null,
        watchColumns: ["price", "changeRate"],
        drawing: DEFAULT_UI_PREFS.drawing,
        lastMinute: "3m",
        collapsedWatchGroups: [],
        indicatorWindow: "inspector",
        layoutMode: "dock",
        venue: "combined",
        orderSettings: DEFAULT_UI_PREFS.orderSettings,
        revision: expect.any(Number),
      },
      keepalive: false,
    },
  ]);
});

test("관심종목은 바꾸자마자 보낸다", async () => {
  useWatchlistStore.getState().add(FIRST_WATCHLIST_ID, "000660");
  await vi.advanceTimersByTimeAsync(0);
  expect(puts).toEqual([
    { path: "/api/watchlists", body: { lists: [{ ...FIRST, symbols: ["005930", "000660"] }], revision: expect.any(Number) }, keepalive: false },
  ]);
});

test("조건부 저장 승인은 자동 저장을 유발하지 않고 다음 로컬 편집은 승인 revision보다 새 값으로 보낸다", async () => {
  const latest = Date.now() + 100_000;
  const lists = [{ ...FIRST, symbols: ["005930", "086520"] }];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ lists, revision: latest })));
  try {
    expect(await commitWatchlist({ next: (server) => ({ lists: [...server.lists] }), still: () => true })).toBe("committed");
  } finally {
    vi.unstubAllGlobals();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(puts).toEqual([{ path: "/api/watchlists", body: { lists, revision: latest + 1 }, keepalive: false }]);
  expect(useWatchlistStore.getState().revision).toBe(latest + 1);
  expect(usePersistStore.getState().saves.watchlist.kind).toBe("saved");
  useWatchlistStore.getState().add(FIRST_WATCHLIST_ID, "000660");
  await vi.advanceTimersByTimeAsync(0);
  expect(puts).toHaveLength(2);
  expect(puts[1]!.body).toMatchObject({ revision: latest + 2, lists: [{ ...FIRST, symbols: ["005930", "086520", "000660"] }] });
});

test("자동 저장이 멈춘 뒤의 관심종목 조건부 저장은 보내지 않고 reject한다", async () => {
  autosave.stop();
  await expect(commitWatchlist({ next: (server) => server, still: () => true })).rejects.toThrow();
  expect(puts).toEqual([]);
});

test("목록을 만들고 종목을 옮기면 목록 전체를 한 본문으로 보낸다", async () => {
  const store = useWatchlistStore.getState();
  store.create("L2", "반도체");
  store.transfer(FIRST_WATCHLIST_ID, "L2", { code: "005930", groupId: null }, "move");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(puts.at(-1)!.body).toEqual({
    lists: [
      { ...FIRST, symbols: [] },
      { id: "L2", name: "반도체", symbols: ["005930"], groups: [] },
    ],
    revision: expect.any(Number),
  });
});

test("옛 한 목록 한도(64KB)에 들던 종목을 가장 긴 감싸개 20개로 감싸도 순서 변경을 보낸다", async () => {
  const legacyBytes = (symbols: string[]) => JSON.stringify({ symbols, revision: Number.MAX_SAFE_INTEGER }).length;
  const codes: string[] = [];
  while (legacyBytes(codes) <= PAYLOAD_LIMIT_BYTES) codes.push(String(100_000 + codes.length));
  codes.pop();
  expect(codes.length).toBeGreaterThanOrEqual(7_274);
  const lists = Array.from({ length: MAX_WATCHLISTS }, (_, i) => ({
    id: String(i).padStart(64, "0"),
    name: "𝄞".repeat(MAX_WATCHLIST_NAME - String(i).length) + i,
    symbols: i === 0 ? codes : [],
    groups: [],
  }));
  useWatchlistStore.getState().load(lists);
  useWatchlistStore.getState().move(lists[0]!.id, { code: codes[1]!, groupId: null }, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(usePersistStore.getState().saves.watchlist).not.toEqual({ kind: "failed", reason: "too_large" });
  expect(puts.at(-1)!.body).toEqual({ lists: [{ ...lists[0], symbols: [codes[1], codes[0], ...codes.slice(2)] }, ...lists.slice(1)], revision: expect.any(Number) });
});

test("UiState가 64KB를 넘으면 최근 본 종목을 지우고 한 번 다시 보낸다", async () => {
  const prefs = { ...DEFAULT_UI_PREFS, lastLayoutId: DEFAULT_LAYOUT.id };
  const base = JSON.stringify({ ...toUiState({ ...prefs, indicatorWindow: "inspector" }, { blob: "" }), revision: Number.MAX_SAFE_INTEGER }).length;
  const blob = "x".repeat(PAYLOAD_LIMIT_BYTES - base);
  useUiStore.getState().load({ ...prefs, recentSymbols: ["005930", "000660"] }, { blob });
  useUiStore.getState().setIndicatorWindow("inspector");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts).toEqual([RECENT_CLEARED]);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.body).toMatchObject({ recentSymbols: [], indicatorWindow: "inspector" });
  expect(useUiStore.getState().prefs.recentSymbols).toEqual([]);
});

test("줄여도 64KB를 넘으면 보내지 않고 실패로 남는다", async () => {
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, recentSymbols: ["005930"] }, { blob: "x".repeat(PAYLOAD_LIMIT_BYTES) });
  useUiStore.getState().setIndicatorWindow("inspector");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.ui).toEqual({ kind: "failed", reason: "too_large" });
});

test("chartSettings가 64KB를 넘으면 레이아웃을 보내지 않는다", async () => {
  const chart = chartWindows(DEFAULT_LAYOUT)[0]!;
  const big = { ...chart.chartSettings, compare: Array.from({ length: 8000 }, (_, i) => String(i).padStart(6, "0")) };
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, windows: [{ ...chart, chartSettings: big }, ...OTHER_WINDOWS] });
  useLayoutStore.getState().setPeriod(CELL, "M");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.layout).toEqual({ kind: "failed", reason: "too_large" });
});

test("placement가 64KB를 넘으면 레이아웃을 보내지 않는다", async () => {
  const order = Array.from({ length: 3000 }, (_, i) => windowId(`window-${i}`));
  const rects = Object.fromEntries(order.map((id) => [id, { x: 0.125, y: 0.25, w: 0.5, h: 0.5 }])) as Record<WindowId, Rect>;
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, placement: { v: 1, dock: null, canvas: { rects, order } } });
  useLayoutStore.getState().setPeriod(CELL, "M");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.layout).toEqual({ kind: "failed", reason: "too_large" });
});

test("탭이 숨으면 기다리던 레이아웃을 keepalive로 곧바로 보낸다", async () => {
  useLayoutStore.getState().setPeriod(CELL, "W");
  autosave.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(puts.map((p) => [p.path, p.keepalive])).toEqual([[`/api/layouts/${DEFAULT_LAYOUT.id}`, true]]);
});

test("칸마다 저장돼 있던 거래소는 저장할 때 주식 창에 combined, 지수 창에 null로 바뀐다", async () => {
  const first = chartWindows(DEFAULT_LAYOUT)[0]!;
  const stored = {
    ...DEFAULT_LAYOUT,
    windows: [{ ...first, symbol: "005930", venue: "nxt" as const }, { ...first, id: "cell-1", symbol: "IDX:001", venue: "krx" as const }, ...OTHER_WINDOWS],
    updatedAt: 1,
    revision: 1,
  };
  const r = await restore({
    uiState: async () => ({ lastLayoutId: DEFAULT_LAYOUT.id, theme: "dark" }),
    layouts: async () => [],
    layout: async () => stored as unknown as Layout,
    watchlists: async () => ({ lists: [{ ...FIRST, symbols: [] }], revision: 0 }),
    unsaved: () => null,
  });
  useLayoutStore.getState().load(r.layout);
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.body).toMatchObject({ windows: [{ symbol: "005930", venue: "combined", period: "W" }, { symbol: "IDX:001", venue: null }, ...OTHER_WINDOWS] });
});
