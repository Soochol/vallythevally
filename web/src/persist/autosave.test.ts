import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_LAYOUT, useLayoutStore } from "../stores/layout";
import { usePersistStore } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { type Autosave, commitWatchlist, RECENT_CLEARED, startAutosave } from "./autosave";
import { PAYLOAD_LIMIT_BYTES } from "./bytes";
import { ApiRequestError } from "../api/http";
import { restore } from "./restore";
import { DEFAULT_UI_PREFS, toUiState } from "./uiState";
import { FIRST_WATCHLIST_ID, MAX_WATCHLIST_NAME, MAX_WATCHLISTS } from "../lib/watchlist";

const FIRST = { id: FIRST_WATCHLIST_ID, name: "기본", groups: [] };

let autosave: Autosave;
let puts: { path: string; body: unknown; keepalive: boolean }[];
let toasts: string[];

beforeEach(() => {
  vi.useFakeTimers();
  puts = [];
  toasts = [];
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
  });
});

afterEach(() => {
  autosave.stop();
  vi.useRealTimers();
});

test("복원한 값을 싣기만 하면 아무것도 보내지 않는다", async () => {
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  useUiStore.getState().pushRecent("IDX:001"); // 첫 칸의 종목은 이미 맨 앞이다
  useLayoutStore.getState().setPeriod(0, "D"); // 같은 값
  await vi.advanceTimersByTimeAsync(10_000);
  expect(puts).toEqual([]);
});

test("칸을 바꾸면 1초 뒤 레이아웃을 통째로 보내고 저장됨이 된다", async () => {
  useLayoutStore.getState().setPeriod(0, "W");
  useLayoutStore.getState().setStyle(0, "line");
  await vi.advanceTimersByTimeAsync(999);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.layout).toEqual({ kind: "pending" });
  await vi.advanceTimersByTimeAsync(1);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.path).toBe(`/api/layouts/${DEFAULT_LAYOUT.id}`);
  expect(puts[0]!.body).toMatchObject({ id: DEFAULT_LAYOUT.id, cells: [{ period: "W", chartSettings: { style: "line" } }] });
  expect(puts[0]!.body).not.toHaveProperty("updatedAt");
  expect(usePersistStore.getState().saves.layout.kind).toBe("saved");
});

test("관심종목 패널을 접으면 모르는 키와 함께 UiState를 보낸다", async () => {
  useUiStore.getState().toggleWatch();
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toEqual([
    {
      path: "/api/ui-state",
      body: {
        phone: 1,
        rightPanel: "watch",
        panelWidth: null,
        lastLayoutId: DEFAULT_LAYOUT.id,
        theme: "dark",
        watchCollapsed: true,
        recentSymbols: ["IDX:001"],
        activeWatchlistId: null,
        watchColumns: ["price", "changeRate"],
        drawing: DEFAULT_UI_PREFS.drawing,
        pinnedMinutes: [],
        collapsedWatchGroups: [],
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
  store.transfer(FIRST_WATCHLIST_ID, "L2", "005930", "move");
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
  useWatchlistStore.getState().move(lists[0]!.id, codes[1]!, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(usePersistStore.getState().saves.watchlist).not.toEqual({ kind: "failed", reason: "too_large" });
  expect(puts.at(-1)!.body).toEqual({ lists: [{ ...lists[0], symbols: [codes[1], codes[0], ...codes.slice(2)] }, ...lists.slice(1)], revision: expect.any(Number) });
});

test("UiState가 64KB를 넘으면 최근 본 종목을 지우고 한 번 다시 보낸다", async () => {
  const prefs = { ...DEFAULT_UI_PREFS, lastLayoutId: DEFAULT_LAYOUT.id };
  const base = JSON.stringify({ ...toUiState(prefs, { blob: "" }), revision: Number.MAX_SAFE_INTEGER }).length;
  const blob = "x".repeat(PAYLOAD_LIMIT_BYTES - base);
  useUiStore.getState().load({ ...prefs, recentSymbols: ["005930", "000660"] }, { blob });
  useUiStore.getState().toggleWatch();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts).toEqual([RECENT_CLEARED]);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.body).toMatchObject({ recentSymbols: [], watchCollapsed: true });
  expect(useUiStore.getState().prefs.recentSymbols).toEqual([]);
});

test("줄여도 64KB를 넘으면 보내지 않고 실패로 남는다", async () => {
  useUiStore.getState().load({ ...DEFAULT_UI_PREFS, recentSymbols: ["005930"] }, { blob: "x".repeat(PAYLOAD_LIMIT_BYTES) });
  useUiStore.getState().toggleWatch();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.ui).toEqual({ kind: "failed", reason: "too_large" });
});

test("chartSettings가 64KB를 넘으면 레이아웃을 보내지 않는다", async () => {
  const big = { ...DEFAULT_LAYOUT.cells[0]!.chartSettings, compare: Array.from({ length: 8000 }, (_, i) => String(i).padStart(6, "0")) };
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, cells: [{ ...DEFAULT_LAYOUT.cells[0]!, chartSettings: big }] });
  useLayoutStore.getState().setPeriod(0, "M");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(puts).toEqual([]);
  expect(usePersistStore.getState().saves.layout).toEqual({ kind: "failed", reason: "too_large" });
});

test("탭이 숨으면 기다리던 레이아웃을 keepalive로 곧바로 보낸다", async () => {
  useLayoutStore.getState().setPeriod(0, "W");
  autosave.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(puts.map((p) => [p.path, p.keepalive])).toEqual([[`/api/layouts/${DEFAULT_LAYOUT.id}`, true]]);
});

test("R1: 종목 정보를 못 받아 통합으로 그리는 NXT 칸은, 봉 주기만 바꿔 저장해도 nxt로 저장된다", async () => {
  const stored = { ...DEFAULT_LAYOUT, cells: [{ ...DEFAULT_LAYOUT.cells[0]!, symbol: "005930", venue: "nxt" as const }], updatedAt: 1, revision: 1 };
  const r = await restore({
    uiState: async () => ({ lastLayoutId: DEFAULT_LAYOUT.id, theme: "dark" }),
    layouts: async () => [],
    layout: async () => stored,
    watchlists: async () => ({ lists: [{ ...FIRST, symbols: [] }], revision: 0 }),
    unsaved: () => null,
    symbolInfo: async () => Promise.reject(new ApiRequestError("kiwoom_unavailable", "잠시 뒤")),
  });
  useLayoutStore.getState().load(r.layout);
  expect(r.layoutDirty).toBe(false);
  useLayoutStore.getState().setPeriod(0, "W");
  await vi.advanceTimersByTimeAsync(1000);
  expect(puts).toHaveLength(1);
  expect(puts[0]!.body).toMatchObject({ cells: [{ symbol: "005930", venue: "nxt", period: "W" }] });
});
