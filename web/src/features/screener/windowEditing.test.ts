import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerStatus } from "../../api/generated/ScreenerStatus";
import type { Screens } from "../../api/generated/Screens";
import { screensQuery } from "../../api/screener";
import { windowId } from "../../layout/kinds";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useScreenerStore } from "../../stores/screener";
import { DEFAULT_SEARCH_COMMANDS } from "../search/commands";
import { screenEditingFor } from "./useScreenEditing";

const A: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [] };
const B: Screen = { id: "b", name: "거래량", markets: [], exclude: [], conditions: [] };
const LIST: Screens = { revision: 1, screens: [A, B] };
const READY: ScreenerStatus = { lastDay: "2026-11-06", needDay: null, todayAvailable: true, fullHistory: { done: 0, total: 0 }, unconfirmed: 0, update: null };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

let sent: string[] = [];
let holdScreens: Promise<void> | null = null;

beforeEach(() => {
  sent = [];
  holdScreens = null;
  useScreenerStore.setState({ runs: {} });
  useLayoutStore.setState({ layout: { ...DEFAULT_LAYOUT, revision: 1 } as never });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/api/screener/run")) {
      sent.push((JSON.parse(String(init?.body)) as Screen).id);
      return reply({ asOf: "2026-11-06", rows: [] });
    }
    if (path.includes("/api/screener/status")) return reply(READY);
    if (path.includes("/api/screens")) {
      if (holdScreens) await holdScreens;
      return reply(LIST);
    }
    throw new Error(`unexpected ${path}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const client = () => {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  c.setQueryData(screensQuery.queryKey, LIST);
  return c;
};

test("폰에서 명령으로 실행하면 폰이 고른 조건식을 실행한다", async () => {
  const queryClient = client();
  const phone = screenEditingFor(queryClient, null);
  phone.choose("b");
  expect(phone.view().chosen?.source.id).toBe("b");
  const command = DEFAULT_SEARCH_COMMANDS.find((c) => c.id === "screener-run")!;
  await command.run({ queryClient, cellId: windowId("cell-0") });
  expect(sent).toEqual(["b"]);
});

test("실행을 기다리는 동안 창을 닫아도 다른 조건식을 실행하지 않는다", async () => {
  const queryClient = client();
  useLayoutStore.setState({ layout: { ...DEFAULT_LAYOUT, revision: 1, windows: [...DEFAULT_LAYOUT.windows, { id: windowId("screener-2"), link: null, kind: "screener", screen: "b" }] } as never });
  const second = screenEditingFor(queryClient, windowId("screener-2"));
  expect(second.view().chosen?.source.id).toBe("b");
  let release!: () => void;
  holdScreens = new Promise((r) => { release = r; });
  const running = second.run();
  useLayoutStore.getState().closeWindow(windowId("screener-2"));
  release();
  await running;
  expect(sent).not.toContain("a");
});

test("레이아웃의 다른 변경에는 같은 뷰를 내고 창의 조건식이 바뀌면 따라간다", () => {
  const queryClient = client();
  const first = screenEditingFor(queryClient, windowId("screener"));
  const before = first.view();
  expect(first.view()).toBe(before);
  useLayoutStore.getState().setLink(windowId("watchlist"), "red" as never);
  expect(first.view()).toBe(before);
  useLayoutStore.getState().setWindowScreen(windowId("screener"), "b");
  expect(first.view().chosen?.source.id).toBe("b");
});

const withScreen = (id: string, screen?: string) => ({ ...DEFAULT_LAYOUT, id, revision: 1, windows: DEFAULT_LAYOUT.windows.map((w) => (w.kind === "screener" ? { ...w, ...(screen ? { screen } : {}) } : w)) });

test("창 id가 같은 레이아웃으로 바꿔도 각 레이아웃의 조건식을 보인다", () => {
  const queryClient = client();
  const win = screenEditingFor(queryClient, windowId("screener"));
  useLayoutStore.setState({ layout: withScreen("L1", "b") as never });
  expect(win.view().chosen?.source.id).toBe("b");
  useLayoutStore.setState({ layout: withScreen("L2") as never });
  expect(win.view().chosen?.source.id).toBe("a");
});

test("실행을 기다리는 동안 레이아웃을 바꿔도 시작한 조건식을 실행한다", async () => {
  const queryClient = client();
  useLayoutStore.setState({ layout: withScreen("L1", "b") as never });
  const win = screenEditingFor(queryClient, windowId("screener"));
  let release!: () => void;
  holdScreens = new Promise((r) => { release = r; });
  const running = win.run();
  useLayoutStore.setState({ layout: withScreen("L2") as never });
  release();
  await running;
  expect(sent).toEqual(["b"]);
});
