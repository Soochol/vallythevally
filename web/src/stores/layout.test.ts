import { beforeEach, expect, test } from "vitest";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { detachWindow, moveFloat } from "../layout/dock/floats";
import { useUiStore } from "./ui";
import { orderEntryKey, type OrderEntry } from "../features/order/orderEntries";
import { DEFAULT_UI_PREFS } from "../persist/uiState";
import { layoutDock } from "../layout/dock/geometry";
import { groupOfWindow, listGroups } from "../layout/dock/tree";
import { MAX_WINDOWS, windowId, type WindowId, type WindowKind } from "../layout/kinds";
import type { CanvasPlacement, DockNode, DockPlacement, Placement } from "../layout/placement";
import { byteLength, PAYLOAD_LIMIT_BYTES } from "../persist/bytes";
import type { LinkColor } from "../api/generated/LinkColor";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { ARRANGEMENT_STEPS, type ChartWindowState, chartWindow, chartWindows, DEFAULT_LAYOUT, DEFAULT_LINK_COLOR, fittedDock, linkedWindowCount, linkedWindowSymbol, useLayoutStore, watchedSymbol, windowName, windowRefs, type WindowState } from "./layout";
import { resetActiveWindow, touchWindow } from "./activeWindow";

const state = () => useLayoutStore.getState();
const shownTab = (kind: string) => {
  const { windows, placement } = state().layout;
  const id = windows.find((w) => w.kind === kind)?.id;
  return id !== undefined && placement.dock !== null && groupOfWindow(placement.dock.root, id)?.active === id;
};

beforeEach(() => {
  resetActiveWindow();
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0, steps: [], redos: [], lastUsedLink: null, groupSymbols: {} });
});

const room = { area: { w: 1256, h: 684 }, gap: 6 };
const firstChart = () => chartWindows(state().layout)[0]!;
const arrangement = () => {
  const { windows, placement } = state().layout;
  return structuredClone({ windows, placement });
};

test("탭 고르기는 맞춘 배치에 고른 탭을 남기고 저장 순서를 올린다", () => {
  state().selectTab(windowId("screener"));
  expect(shownTab("screener")).toBe(true);
  expect(state().revision).toBe(1);
  state().selectTab(windowId("screener"));
  expect(state().revision).toBe(1);
});

test("창 보이기는 있는 창의 탭을 고르고, 없는 창은 더해 기본 자리의 탭으로 고른다", () => {
  state().showWindow("screener");
  expect(shownTab("screener")).toBe(true);
  const windows = state().layout.windows.length;
  state().showWindow("indicators");
  expect(state().layout.windows).toHaveLength(windows + 1);
  expect(state().layout.windows.at(-1)).toEqual({ id: "indicators", link: null, kind: "indicators" });
  expect(shownTab("indicators")).toBe(true);
  const side = groupOfWindow(state().layout.placement.dock!.root, windowId("watchlist"))!;
  expect(side.tabs).toContain("indicators");
  state().showWindow("indicators");
  expect(state().layout.windows).toHaveLength(windows + 1);
});

test("새 창 id는 이미 쓰는 id를 피한다", () => {
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.windows = layout.windows.map((w) => (w.kind === "screener" ? { ...w, id: windowId("indicators") } : w));
  useLayoutStore.setState({ layout });
  state().showWindow("indicators");
  expect(state().layout.windows.filter((w) => w.kind === "indicators")).toEqual([{ id: "indicators-2", link: null, kind: "indicators" }]);
});

test("배치 반영은 같은 배치면 저장하지 않는다", () => {
  const dock = fittedDock(state().layout);
  state().setDock(dock);
  expect(state().revision).toBe(1);
  state().setDock(dock);
  expect(state().revision).toBe(1);
  expect(listGroups(state().layout.placement.dock!.root)).toHaveLength(2);
});

const chart = (id: string, link: LinkColor | null, symbol: SymbolCode, period: ChartWindowState["period"]): ChartWindowState =>
  ({ id: windowId(id), link, kind: "chart", symbol, period, chartSettings: DEFAULT_CHART_SETTINGS });

function linked(...extra: WindowState[]) {
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.windows = [
    chart("a1", "a", "005930", "D"),
    chart("a2", "a", "005930", "W"),
    chart("off", null, "000660", "D"),
    chart("b1", "b", "035420", "5m"),
    { id: windowId("watchlist"), link: null, kind: "watchlist" },
    { id: windowId("screener"), link: null, kind: "screener" },
    ...extra,
  ];
  useLayoutStore.setState({ layout, revision: 0 });
}

const shown = () => Object.fromEntries(chartWindows(state().layout).map((w) => [w.id, [w.symbol, w.period]]));
const SK = { code: "000660", name: "SK하이닉스" };
const SAMSUNG = { code: "005930", name: "삼성전자" };

test("같은 색의 차트 창 하나의 종목을 바꾸면 그 색의 차트가 모두 바뀌고 봉 주기는 각자 그대로다", () => {
  linked();
  const change = state().setSymbol(windowId("a2"), SK);
  expect(shown()).toEqual({
    a1: ["000660", "D"],
    a2: ["000660", "W"],
    off: ["000660", "D"],
    b1: ["035420", "5m"],
  });
  expect(change).toEqual({ changed: ["a1", "a2"], notice: null });
  expect(state().revision).toBe(1);
});

test("색이 다른 차트와 색이 꺼진 차트는 함께 바뀌지 않고, 알리지 않는다", () => {
  linked();
  expect(state().setSymbol(windowId("off"), SAMSUNG)).toEqual({ changed: ["off"], notice: null });
  expect(state().setSymbol(windowId("b1"), SK)).toEqual({ changed: ["b1"], notice: null });
  expect(shown()).toEqual({
    a1: ["005930", "D"],
    a2: ["005930", "W"],
    off: ["005930", "D"],
    b1: ["000660", "5m"],
  });
});

test("여러 차트가 함께 바뀌어도 알림을 돌려주지 않고, 이미 그 종목이면 바뀐 차트가 없다", () => {
  linked();
  expect(state().setSymbol(windowId("a1"), { code: "051910", name: "LG화학" })).toEqual({ changed: ["a1", "a2"], notice: null });
  expect(state().setSymbol(windowId("a1"), { code: "000270" })).toEqual({ changed: ["a1", "a2"], notice: null });
  expect(state().setSymbol(windowId("a1"), { code: "000270" })).toEqual({ changed: [], notice: null });
});

test("차트의 색을 이미 쓰는 색으로 바꾸면 그 색의 종목을 따르고, 쓰는 차트가 없는 색이면 종목을 그대로 둔다", () => {
  linked();
  state().setLink(windowId("off"), "a");
  expect(state().layout.windows.find((w) => w.id === "off")).toMatchObject({ link: "a", symbol: "005930", period: "D" });
  state().setLink(windowId("b1"), "c");
  expect(state().layout.windows.find((w) => w.id === "b1")).toMatchObject({ link: "c", symbol: "035420", period: "5m" });
  state().setLink(windowId("b1"), "a");
  expect(shown().b1).toEqual(["005930", "5m"]);
  expect(state().revision).toBe(3);
});

test("같은 연동 색을 쓰는 다른 창만 센다. 연동 색은 지표 창에는 붙지 않는다", () => {
  const windows = [{ id: windowId("x"), link: "a" }, { id: windowId("y"), link: "a" }, { id: windowId("z"), link: "b" }, { id: windowId("w"), link: null }, { id: windowId("v"), link: "j" }] as WindowState[];
  expect([linkedWindowCount(windows, "a", windowId("x")), linkedWindowCount(windows, "b", windowId("x")), linkedWindowCount(windows, "c", windowId("x")), linkedWindowCount(windows, "j", windowId("x"))]).toEqual([1, 1, 0, 1]);
  linked({ id: windowId("indicators"), link: null, kind: "indicators" });
  state().setLink(windowId("indicators"), "a");
  state().setLink(windowId("watchlist"), "b");
  expect(state().layout.windows.filter((w) => w.kind !== "chart").map((w) => [w.id, w.link])).toEqual([
    ["watchlist", "b"], ["screener", null], ["indicators", null],
  ]);
  expect(state().revision).toBe(1);
});

test("색 A인 보내는 창이 종목을 보내면 A인 차트만 바뀌고, A인 차트가 없으면 아무것도 바꾸지 않고 알림도 없다", () => {
  linked();
  state().setLink(windowId("watchlist"), "a");
  const revision = state().revision;
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SK)).toEqual({ changed: ["a1", "a2"], notice: null });
  expect(shown()).toMatchObject({ a1: ["000660", "D"], a2: ["000660", "W"], off: ["000660", "D"], b1: ["035420", "5m"] });
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SAMSUNG).changed).toEqual(["a1", "a2"]);
  expect(shown().off).toEqual(["000660", "D"]);

  state().setLink(windowId("screener"), "c");
  const before = state().layout;
  const after = state().revision;
  expect(state().sendSymbol(windowId("screener"), windowId("off"), SK)).toEqual({ changed: [], notice: null });
  expect(state().layout).toBe(before);
  expect(state().revision).toBe(after);
  expect(after).toBeGreaterThan(revision);
});

test("페이지가 색 A로 보내면 A인 차트가 바뀌고, 그 색의 차트가 없거나 색이 꺼져 있으면 활성 칸의 차트가 바뀐다", () => {
  linked();
  expect(state().sendSymbolToLink("a", windowId("off"), SK)).toEqual({ changed: ["a1", "a2"], notice: null });
  expect(shown().off).toEqual(["000660", "D"]);
  expect(state().sendSymbolToLink("c", windowId("off"), SAMSUNG)).toEqual({ changed: ["off"], notice: null });
  expect(state().sendSymbolToLink(null, windowId("b1"), SAMSUNG)).toEqual({ changed: ["b1"], notice: null });
  expect(shown()).toMatchObject({ a1: ["000660", "D"], a2: ["000660", "W"], off: ["005930", "D"], b1: ["005930", "5m"] });
});

test("색이 꺼진 보내는 창은 외부 창을 바꾸지 않고, 휴대폰 목록(sender=null)만 활성 칸을 바꾼다", () => {
  linked();
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SAMSUNG)).toEqual({ changed: [], notice: null });
  expect(state().sendSymbol(windowId("screener"), windowId("a2"), SK)).toEqual({ changed: [], notice: null });
  expect(shown()).toEqual({
    a1: ["005930", "D"],
    a2: ["005930", "W"],
    off: ["000660", "D"],
    b1: ["035420", "5m"],
  });
  expect(state().sendSymbol(null, windowId("b1"), SAMSUNG)).toEqual({ changed: ["b1"], notice: null });
  expect(shown().b1).toEqual(["005930", "5m"]);
});

test("종목을 바꾸면 그 색의 모든 차트의 종목이 바뀌고 봉 주기는 각자 그대로다", () => {
  linked();
  state().setSymbol(windowId("a1"), { code: "IDX:001" });
  expect([shown().a1, shown().a2]).toEqual([["IDX:001", "D"], ["IDX:001", "W"]]);
  state().setSymbol(windowId("a1"), SAMSUNG);
  expect([shown().a1, shown().a2]).toEqual([["005930", "D"], ["005930", "W"]]);
});

test("보내는 창이 보고 있는 종목은 자기 색의 차트 종목이고, 색이 꺼져 있으면 활성 칸의 종목, 그 색의 차트가 없으면 없다", () => {
  linked();
  const layout = () => state().layout;
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"), state().groupSymbols)).toBe("035420");
  expect(watchedSymbol(layout(), null, windowId("off"), state().groupSymbols)).toBe("000660");
  state().setLink(windowId("watchlist"), "a");
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"), state().groupSymbols)).toBe("005930");
  state().setLink(windowId("watchlist"), "c");
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"), state().groupSymbols)).toBeNull();
});

test("색을 맞추면 앞선 차트의 종목을 따른다", () => {
  linked();
  state().setLink(windowId("off"), "a");
  expect(shown().off).toEqual(["005930", "D"]);
});

test("차트 더하기는 원본 칸의 종목·봉 주기·차트 설정·연동 색을 복사해 원본 옆 묶음에 놓고, 8개가 차면 더하지 않는다", () => {
  const source = { ...firstChart(), symbol: "005930", period: "W" as const, link: "b" as const, chartSettings: { ...DEFAULT_CHART_SETTINGS, style: "line" as const, visibleBars: 120 } };
  useLayoutStore.setState({ layout: { ...state().layout, windows: state().layout.windows.map((w) => (w.id === source.id ? source : w)) } });
  const id = state().addChart(source.id, room);
  if (!id) throw new Error("차트 창을 더하지 못했습니다");
  expect(chartWindow(state().layout, id)).toEqual({ ...source, id });
  expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  const dock = state().layout.placement.dock!;
  const boxes = layoutDock(dock.root, room.area, room.gap).groups;
  const boxOf = (window: string) => boxes.find((box) => box.group.tabs.includes(windowId(window)))!.rect;
  expect(boxOf(id).x).toBeGreaterThan(boxOf(source.id).x + boxOf(source.id).w);
  expect(boxOf(id).y).toBe(boxOf(source.id).y);

  while (chartWindows(state().layout).length < 8) expect(state().addChart(source.id, room)).not.toBeNull();
  const full = state().layout;
  expect(state().addChart(source.id, room)).toBeNull();
  expect(state().layout).toBe(full);
  expect(full.windows.length).toBeLessThanOrEqual(MAX_WINDOWS);
  expect(new Set(full.windows.map((w) => w.id)).size).toBe(full.windows.length);
  expect(listGroups(full.placement.dock!.root).flatMap((group) => group.tabs).sort()).toEqual(full.windows.map((w) => w.id).sort());
});

test("이미 있는 종류를 다시 보이면 창 수가 그대로이고 기록하지 않는다", () => {
  state().showWindow("screener");
  expect(state().layout.windows).toHaveLength(DEFAULT_LAYOUT.windows.length);
  expect(shownTab("screener")).toBe(true);
  expect(state().steps).toHaveLength(0);
});

test("마지막 차트 창은 닫지 않는다", () => {
  const before = state().layout;
  expect(state().closeWindow(firstChart().id)).toBe(false);
  expect(state().layout).toBe(before);
});

test("묶음의 마지막 탭을 닫으면 묶음이 사라지고 이웃이 자리를 채운다", () => {
  for (const id of ["watchlist", "screener"]) expect(state().closeWindow(windowId(id))).toBe(true);
  expect(state().layout.windows.map((w) => w.kind)).toEqual(["chart"]);
  expect(state().layout.placement.dock!.root).toEqual({ kind: "group", id: "g1", tabs: [firstChart().id], active: firstChart().id });
});

test("더하기 → 닫기 → 되돌리기 → 되돌리기 뒤 처음 창 목록과 배치로 돌아온다", () => {
  const start = arrangement();
  const id = state().addChart(firstChart().id, room)!;
  expect(state().closeWindow(windowId("screener"))).toBe(true);
  expect(state().steps).toHaveLength(2);
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "screener")).toBe(true);
  expect(state().layout.windows.some((w) => w.id === id)).toBe(true);
  state().undoArrangement();
  expect(arrangement()).toEqual(start);
  expect(state().steps).toHaveLength(0);
  const revision = state().revision;
  state().undoArrangement();
  expect(state().revision).toBe(revision);
});

test(`배치 기록은 최근 ${ARRANGEMENT_STEPS}단계만 남기고, 레이아웃을 통째로 열면 비운다`, () => {
  const start = arrangement();
  for (let n = 0; n < ARRANGEMENT_STEPS + 1; n += 1) {
    if (n % 2 === 0) state().showWindow("indicators");
    else state().closeWindow(windowId("indicators"));
  }
  expect(state().steps).toHaveLength(ARRANGEMENT_STEPS);
  for (let n = 0; n < ARRANGEMENT_STEPS; n += 1) state().undoArrangement();
  expect(state().layout.windows.some((w) => w.kind === "indicators")).toBe(true);
  expect(arrangement()).not.toEqual(start);

  state().showWindow("indicators");
  state().closeWindow(windowId("screener"));
  state().load(structuredClone(DEFAULT_LAYOUT));
  expect(state().steps).toHaveLength(0);
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "screener")).toBe(true);
});

test("탭 고르기와 배치 맞추기는 기록하지 않고, 경계 옮기기는 한 단계로 기록한다", () => {
  state().selectTab(windowId("screener"));
  state().settleDock(fittedDock(state().layout));
  expect(state().steps).toHaveLength(0);
  const dock = fittedDock(state().layout);
  if (dock.root.kind !== "split") throw new Error("기본 배치가 나뉘어 있지 않습니다");
  state().setDock({ ...dock, root: { ...dock.root, ratio: 0.6 } });
  expect(state().steps).toHaveLength(1);
  state().undoArrangement();
  expect(state().layout.placement.dock).toBe(dock);
});

test("닫은 차트를 되돌리면 그 창의 종목·봉 주기·차트 설정이 돌아오고, 남은 창의 내용은 지금 값을 유지한다", () => {
  const id = state().addChart(firstChart().id, room)!;
  state().setSymbol(id, { code: "005930", name: "삼성전자" });
  state().setPeriod(id, "W");
  state().setStyle(id, "area");
  state().setVisibleBars(id, 90);
  const closed = chartWindow(state().layout, id);
  expect(state().closeWindow(id)).toBe(true);
  state().setPeriod(firstChart().id, "M");
  state().undoArrangement();
  expect(chartWindow(state().layout, id)).toEqual(closed);
  expect(firstChart().period).toBe("M");
  expect(windowRefs(state().layout.windows).map((w) => w.id)).toContain(id);
});

test("닫은 연동 차트를 되돌리면 지금 같은 색 차트의 종목을 따르고 봉 주기와 차트 설정은 닫을 때 값이다", () => {
  linked();
  const closed = chartWindows(state().layout).find((w) => w.id === "a2")!;
  expect(state().closeWindow(windowId("a2"))).toBe(true);
  state().setSymbol(windowId("a1"), SK);
  state().setLink(windowId("off"), "b");
  state().undoArrangement();
  expect(shown().a2).toEqual(["000660", "W"]);
  expect(chartWindows(state().layout).find((w) => w.id === "a2")!.chartSettings).toBe(closed.chartSettings);
  expect(new Set(chartWindows(state().layout).filter((w) => w.link === "a").map((w) => w.symbol)).size).toBe(1);
  expect(new Set(chartWindows(state().layout).filter((w) => w.link === "b").map((w) => w.symbol)).size).toBe(1);
});

test("묶음 더하기는 기존 창 옮기기와 새 차트 더하기를 각각 한 번에 되돌린다", () => {
  state().settleDock(fittedDock(state().layout));
  const original = arrangement();
  state().showWindow("watchlist", "g1");
  expect(groupOfWindow(fittedDock(state().layout).root, windowId("watchlist"))?.id).toBe("g1");
  expect(state().steps).toHaveLength(1);
  state().showWindow("watchlist", "g1");
  expect(state().steps).toHaveLength(1);
  state().undoArrangement();
  expect(arrangement()).toEqual(original);
  const id = state().addChart(firstChart().id, room, "g2");
  expect(id).not.toBeNull();
  if (!id) throw new Error("차트를 더하지 못했습니다");
  expect(groupOfWindow(fittedDock(state().layout).root, id)?.id).toBe("g2");
  expect(state().steps).toHaveLength(1);
  state().undoArrangement();
  expect(arrangement()).toEqual(original);
});

test("사라진 묶음에는 창이나 기록을 더하지 않는다", () => {
  const before = arrangement();
  state().showWindow("indicators", "missing");
  expect(state().addChart(firstChart().id, room, "missing")).toBeNull();
  expect(arrangement()).toEqual(before);
  expect(state().steps).toHaveLength(0);
});

test("십자선 연동은 scroll과 배치 기록을 지키고 바뀔 때만 저장 순서를 올린다", () => {
  state().setDock(fittedDock(state().layout));
  const { windows, placement, sync } = state().layout;
  const steps = state().steps;
  const revision = state().revision;
  state().setCrosshairSync(false);
  expect(state().layout.sync).toEqual({ crosshair: false, scroll: sync.scroll, crosshairScope: sync.crosshairScope });
  expect(state().layout.windows).toBe(windows);
  expect(state().layout.placement).toBe(placement);
  expect(state().steps).toBe(steps);
  expect(state().revision).toBe(revision + 1);
  state().setCrosshairSync(false);
  expect(state().revision).toBe(revision + 1);
  state().setCrosshairSync(true);
  expect(state().layout.sync.crosshair).toBe(true);
  expect(state().revision).toBe(revision + 2);
});


test("도킹 떠 있는 창의 한 동작을 한 단계로 기록하고 되돌리기는 원래 묶음 기억도 되살린다", () => {
  useUiStore.setState((s) => ({ prefs: { ...s.prefs, layoutMode: "dock" } }));
  state().load(structuredClone(DEFAULT_LAYOUT));
  const dock = fittedDock(state().layout);
  state().settleDock(dock);
  const id = windowId("screener");
  const origin = groupOfWindow(dock.root, id)!.id;
  const floated = detachWindow(dock, id, { x: .2, y: .2, w: .3, h: .4 });
  expect(state().commitDock({ session: state().session, expected: dock, next: floated })).toBe(true);
  expect(state().steps).toHaveLength(1);
  expect(state().dockOrigins.get(id)).toBe(origin);
  const moved = moveFloat(floated, id, { x: .3, y: .2, w: .3, h: .4 });
  state().commitDock({ session: state().session, expected: floated, next: moved });
  expect(state().steps).toHaveLength(2);
  state().attachFloat(id);
  expect(state().steps).toHaveLength(3);
  expect(groupOfWindow(state().layout.placement.dock!.root, id)?.id).toBe(origin);
  expect(state().dockOrigins.has(id)).toBe(false);
  state().undoArrangement();
  expect(state().layout.placement.dock).toBe(moved);
  expect(state().dockOrigins.get(id)).toBe(origin);
  state().undoArrangement();
  expect(state().layout.placement.dock).toBe(floated);
  state().undoArrangement();
  expect(state().layout.placement.dock).toBe(dock);
});

test("오래된 도킹 세션·배치·방식의 커밋을 거절하고 같은 배치는 기록하지 않는다", () => {
  useUiStore.setState((s) => ({ prefs: { ...s.prefs, layoutMode: "dock" } }));
  state().load(structuredClone(DEFAULT_LAYOUT));
  const dock = fittedDock(state().layout);
  state().settleDock(dock);
  const session = state().session;
  const next = detachWindow(dock, windowId("screener"), { x: .1, y: .1, w: .3, h: .4 });
  expect(state().commitDock({ session, expected: dock, next: { ...dock } })).toBe(true);
  expect(state().steps).toHaveLength(0);
  expect(state().commitDock({ session: session - 1, expected: dock, next })).toBe(false);
  expect(state().commitDock({ session, expected: { ...dock }, next })).toBe(false);
  useUiStore.setState((s) => ({ prefs: { ...s.prefs, layoutMode: "canvas" } }));
  expect(state().commitDock({ session, expected: dock, next })).toBe(false);
  useUiStore.setState((s) => ({ prefs: { ...s.prefs, layoutMode: "dock" } }));
  state().commitDock({ session, expected: dock, next });
  state().load(state().layout);
  expect(state().dockOrigins.size).toBe(0);
  expect(state().commitDock({ session, expected: next, next: dock })).toBe(false);
  state().attachFloat(windowId("screener"));
  expect(state().layout.placement.dock!.floats).toHaveLength(0);
});


test("저장하지 않은 기본 도킹의 커밋은 초기 저장 없이 원래 묶음을 기억하고 한 단계로 되돌린다", () => {
  useUiStore.getState().setLayoutMode("dock");
  state().load(structuredClone(DEFAULT_LAYOUT));
  const dock = fittedDock(state().layout);
  expect(state().commitDock({ session: state().session, expected: null, next: dock })).toBe(true);
  expect(state().layout.placement.dock).toBeNull();
  expect(state().steps).toHaveLength(0);
  const floated = detachWindow(dock, windowId("screener"), { x: .2, y: .2, w: .3, h: .4 });
  expect(state().commitDock({ session: state().session, expected: null, next: floated })).toBe(true);
  expect(state().dockOrigins.get(windowId("screener"))).toBe("g2");
  expect(state().steps).toHaveLength(1);
  state().undoArrangement();
  expect(state().layout.placement.dock).toBeNull();
});

const fillWithTrades = () => {
  while (state().layout.windows.length < MAX_WINDOWS) expect(state().openWindow("trades")).not.toBeNull();
};

test("창이 상한 50개이면 새 창과 복제는 아무것도 바꾸지 않고 열려 있는 종류는 첫 창을 고른다", () => {
  state().showWindow("indicators");
  fillWithTrades();
  const before = arrangement();
  expect(state().addChart(firstChart().id, room)).toBeNull();
  expect(state().openWindow("book")).toBeNull();
  expect(state().openWindow("trades")).toBeNull();
  expect(state().duplicateWindow(windowId("trades"))).toBeNull();
  expect(arrangement()).toEqual(before);
  state().showWindow("trades");
  expect(state().layout.windows).toHaveLength(MAX_WINDOWS);
  expect(shownTab("trades")).toBe(true);
});

test("같은 종류 창 더하기는 kind-2 id로 둘째 창을 만들고 그 탭을 고른다", () => {
  state().openWindow("trades");
  expect(state().openWindow("trades")).toBe("trades-2");
  expect(state().layout.windows.filter((w) => w.kind === "trades")).toEqual([{ id: "trades", link: null, kind: "trades" }, { id: "trades-2", link: null, kind: "trades" }]);
  expect(groupOfWindow(state().layout.placement.dock!.root, windowId("trades-2"))?.active).toBe("trades-2");
  expect(state().openWindow("watchlist")).toBe("watchlist-2");
  expect(state().layout.windows.filter((w) => w.kind === "watchlist")).toHaveLength(2);
});

test("지표 창은 하나만 더해지고 더하기를 다시 해도 그대로다", () => {
  expect(state().openWindow("indicators")).toBe("indicators");
  const before = arrangement();
  expect(state().openWindow("indicators")).toBeNull();
  expect(arrangement()).toEqual(before);
});

test("창 보이기는 같은 종류가 여럿이면 창 목록 순서의 첫 창을 고른다", () => {
  state().openWindow("trades");
  state().openWindow("trades");
  expect(shownTab("trades")).toBe(false);
  expect(groupOfWindow(state().layout.placement.dock!.root, windowId("trades-2"))?.active).toBe("trades-2");
  state().showWindow("trades");
  expect(groupOfWindow(state().layout.placement.dock!.root, windowId("trades"))?.active).toBe("trades");
  const windows = state().layout.windows.length;
  state().showWindow("trades");
  expect(state().layout.windows).toHaveLength(windows);
});

test("복제는 연동 색을 옮긴 새 창을 같은 묶음의 그 탭 바로 오른쪽에 놓고 고른다", () => {
  state().openWindow("order");
  state().setLink(windowId("order"), "a");
  const group = () => groupOfWindow(state().layout.placement.dock!.root, windowId("order"))!;
  state().openWindow("trades", group().id);
  expect(group().tabs.slice(-2)).toEqual(["order", "trades"]);
  const copy = state().duplicateWindow(windowId("order"));
  expect(copy).toBe("order-2");
  expect(state().layout.windows.find((w) => w.id === copy)).toEqual({ id: "order-2", link: "a", kind: "order", venue: "krx" });
  expect(group().tabs.slice(-3)).toEqual(["order", "order-2", "trades"]);
  expect(group().active).toBe("order-2");
  expect(state().steps.at(-1)?.before.windows.some((w) => w.id === "order-2")).toBe(false);
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "order-2")).toBe(false);
});

test("새 순위 창은 앱 전체 거래소와 거래대금·시장 전체·ETF·ETN 빼기 켬으로 시작하고 복제는 설정까지 옮긴다", () => {
  try {
    useUiStore.getState().setVenue("nxt");
    const id = state().openWindow("ranking");
    expect(id).toBe("ranking");
    const expected = { kind: "tradeAmount", market: "all", venue: "nxt", excludes: { etfEtn: true, preferred: false }, excludeManaged: false };
    expect(state().layout.windows.find((w) => w.id === id)).toEqual({ id: "ranking", link: "a", kind: "ranking", ranking: expected });
    expect(state().openWindow("ranking")).toBe("ranking-2");
    state().setLink(windowId("ranking"), "b");
    const copy = state().duplicateWindow(windowId("ranking"));
    expect(copy).toBe("ranking-3");
    expect(state().layout.windows.find((w) => w.id === copy)).toEqual({ id: "ranking-3", link: "b", kind: "ranking", ranking: expected });
    useUiStore.getState().setVenue("combined");
    state().openWindow("ranking");
    expect(state().layout.windows.find((w) => w.id === "ranking-4")).toMatchObject({ ranking: { venue: "combined" } });
  } finally {
    useUiStore.getState().setVenue("combined");
  }
});

test("창별 상태 setter 셋은 그 종류의 창에만 값을 쓰고 null이면 값을 지운다", () => {
  state().openWindow("watchlist");
  state().openWindow("trades");
  state().openWindow("order");
  const find = (id: string) => state().layout.windows.find((w) => w.id === id)!;
  state().setWindowList(windowId("watchlist-2"), "L-반도체");
  state().setWindowScreen(windowId("screener"), "S-고가");
  state().pinSymbol(windowId("trades"), "005930");
  state().pinSymbol(windowId("order"), "000660");
  expect(find("watchlist-2")).toEqual({ id: "watchlist-2", link: "a", kind: "watchlist", list: "L-반도체" });
  expect(find("watchlist")).toEqual({ id: "watchlist", link: null, kind: "watchlist" });
  expect(find("screener")).toEqual({ id: "screener", link: null, kind: "screener", screen: "S-고가" });
  expect(find("trades")).toEqual({ id: "trades", link: null, kind: "trades", symbol: "005930" });
  expect(find("order")).toEqual({ id: "order", link: null, kind: "order", venue: "krx", symbol: "000660" });
  const revision = state().revision;
  state().setWindowList(windowId("watchlist-2"), "L-반도체");
  expect(state().revision).toBe(revision);
  state().setWindowList(windowId("watchlist-2"), null);
  state().setWindowScreen(windowId("screener"), null);
  state().pinSymbol(windowId("trades"), null);
  expect(find("watchlist-2")).toEqual({ id: "watchlist-2", link: "a", kind: "watchlist" });
  expect(find("screener")).toEqual({ id: "screener", link: null, kind: "screener" });
  expect(find("trades")).toEqual({ id: "trades", link: null, kind: "trades" });
});

test("창별 상태 setter는 다른 종류의 창 id와 없는 id에는 아무것도 바꾸지 않고, 고정 종목은 지수를 받지 않는다", () => {
  state().openWindow("trades");
  state().showWindow("indicators");
  const before = arrangement();
  const revision = state().revision;
  state().setWindowList(windowId("screener"), "L1");
  state().setWindowList(windowId("nope"), "L1");
  state().setWindowScreen(windowId("watchlist"), "S1");
  state().pinSymbol(windowId("watchlist"), "005930");
  state().pinSymbol(windowId("screener"), "005930");
  state().pinSymbol(windowId("indicators"), "005930");
  state().pinSymbol(firstChart().id, "005930");
  state().pinSymbol(windowId("trades"), "IDX:001");
  expect(arrangement()).toEqual(before);
  expect(state().revision).toBe(revision);
});

test("복제는 창별 상태(목록, 조건식, 고정 종목)도 옮기고 복제본을 바꿔도 원본은 그대로다", () => {
  state().openWindow("order");
  state().pinSymbol(windowId("order"), "005930");
  state().setWindowList(windowId("watchlist"), "L-등락");
  const orderCopy = state().duplicateWindow(windowId("order"));
  const listCopy = state().duplicateWindow(windowId("watchlist"));
  const find = (id: string | null) => state().layout.windows.find((w) => w.id === id);
  expect(find(orderCopy)).toMatchObject({ kind: "order", venue: "krx", symbol: "005930" });
  expect(find(listCopy)).toMatchObject({ kind: "watchlist", list: "L-등락" });
  state().pinSymbol(windowId(orderCopy!), null);
  state().setWindowList(windowId(listCopy!), "L-다른");
  expect(find("order")).toMatchObject({ symbol: "005930" });
  expect(find("watchlist")).toMatchObject({ list: "L-등락" });
});

test("복제는 차트와 지표와 없는 창과 떠 있는 창에서는 아무것도 하지 않는다", () => {
  state().showWindow("indicators");
  const before = arrangement();
  expect(state().duplicateWindow(firstChart().id)).toBeNull();
  expect(state().duplicateWindow(windowId("indicators"))).toBeNull();
  expect(state().duplicateWindow(windowId("nope"))).toBeNull();
  expect(arrangement()).toEqual(before);
  const dock = fittedDock(state().layout);
  state().setDock(detachWindow(dock, windowId("watchlist"), { x: 10, y: 10, w: 300, h: 300 }));
  expect(state().duplicateWindow(windowId("watchlist"))).toBeNull();
});

test("같은 종류가 둘 이상인 창 이름에만 창 목록 순서의 번호가 붙고 차트 이름은 그대로다", () => {
  const refs = (...ids: [string, WindowKind][]) => ids.map(([id, kind]) => ({ id: windowId(id), kind }));
  const windows = refs(["cell-0", "chart"], ["cell-1", "chart"], ["trades-2", "trades"], ["book", "book"], ["trades", "trades"]);
  expect(windows.map((w) => windowName(windows, w))).toEqual(["차트", "차트", "체결 1", "10호가", "체결 2"]);
  expect(windowName(windows.slice(0, 4), windows[2]!)).toBe("체결");
});

test("창 50개를 모두 따로 묶은 도킹 배치, 일부를 띄운 도킹 배치, 캔버스 배치를 함께 담아도 64KB보다 작다", () => {
  const ids = Array.from({ length: MAX_WINDOWS }, (_, n) => windowId(`trades-${n + 1}-with-a-long-window-identifier`));
  const rect = (n: number) => ({ x: 123.45678901234567 + n, y: 234.56789012345678 + n, w: 345.6789012345678, h: 456.789012345678 });
  const tree = (docked: readonly WindowId[], from: number, to: number): DockNode => {
    const middle = from + Math.ceil((to - from) / 2);
    return to - from === 1
      ? { kind: "group", id: `g${from}`, tabs: [docked[from]!], active: docked[from]! }
      : { kind: "split", dir: from % 2 === 0 ? "row" : "column", ratio: 0.5123456789012345, first: tree(docked, from, middle), second: tree(docked, middle, to) };
  };
  const separate: DockPlacement = { root: tree(ids, 0, ids.length), floats: [] };
  const mixed: DockPlacement = { root: tree(ids.slice(0, 26), 0, 26), floats: ids.slice(26).map((window, n) => ({ window, rect: rect(n) })) };
  const canvas: CanvasPlacement = { rects: Object.fromEntries(ids.map((id, n) => [id, rect(n)])), order: ids };
  for (const dock of [separate, mixed]) {
    const placement: Placement = { v: 1, dock, canvas };
    expect(byteLength(JSON.stringify(placement))).toBeLessThan(PAYLOAD_LIMIT_BYTES);
  }
});

test("시세 창이 보이는 종목은 고정 종목이 연동 색과 활성 칸보다 먼저이고, 고정이 없으면 지금 규칙과 같다", () => {
  linked();
  state().openWindow("trades", undefined, { link: null });
  state().openWindow("book", undefined, { link: null });
  const layout = () => state().layout;
  const shownIn = (id: string, active: string) => linkedWindowSymbol(layout(), windowId(id), windowId(active), state().groupSymbols);
  expect([shownIn("trades", "off"), shownIn("trades", "b1")]).toEqual(["000660", "035420"]);
  state().setLink(windowId("book"), "a");
  expect(shownIn("book", "b1")).toBe(watchedSymbol(layout(), windowId("book"), windowId("b1"), state().groupSymbols));
  state().pinSymbol(windowId("trades"), "005930");
  state().pinSymbol(windowId("book"), "005930");
  expect([shownIn("trades", "off"), shownIn("trades", "b1"), shownIn("book", "b1")]).toEqual(["005930", "005930", "005930"]);
  state().setSymbol(windowId("a1"), SK);
  expect(shownIn("book", "b1")).toBe("005930");
  state().pinSymbol(windowId("trades"), null);
  expect(shownIn("trades", "b1")).toBe("035420");
});

test("고정된 창에 연동 색을 고르면 고정이 풀리고 그 색을 따르며, 끔을 고르면 고정이 남는다", () => {
  linked();
  state().openWindow("trades", undefined, { link: null });
  state().pinSymbol(windowId("trades"), "005930");
  state().setLink(windowId("trades"), null);
  expect(state().layout.windows.find((w) => w.id === "trades")).toMatchObject({ symbol: "005930" });
  state().setLink(windowId("trades"), "b");
  const trades = state().layout.windows.find((w) => w.id === "trades")!;
  expect(trades).toEqual({ id: "trades", link: "b", kind: "trades" });
  expect(linkedWindowSymbol(state().layout, windowId("trades"), windowId("off"), state().groupSymbols)).toBe("035420");
});

test("관심종목·스크리너의 보이는 종목은 창 종목이 아니라 보내는 규칙으로만 정해진다", () => {
  linked();
  state().openWindow("trades", undefined, { link: null });
  state().pinSymbol(windowId("trades"), "005930");
  const layout = () => state().layout;
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"), state().groupSymbols)).toBe("035420");
  expect(watchedSymbol(layout(), windowId("trades"), windowId("b1"), state().groupSymbols)).toBe("035420");
  expect(watchedSymbol(layout(), null, windowId("off"), state().groupSymbols)).toBe("000660");
});

test("새 창은 활성 창의 연동 색을 상속하고, 활성 창이 무그룹이거나 없으면 마지막 사용 연동 색, 그것도 없으면 A로 만든다", () => {
  linked();
  touchWindow(windowId("b1"));
  const bookId = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === bookId)?.link).toBe("b");
  expect(linkedWindowSymbol(state().layout, bookId, windowId("a1"), state().groupSymbols)).toBe("035420");

  touchWindow(windowId("off"));
  const tradesId = state().openWindow("trades")!;
  expect(state().layout.windows.find((w) => w.id === tradesId)?.link).toBe("b");
  expect(linkedWindowSymbol(state().layout, tradesId, windowId("a1"), state().groupSymbols)).toBe("035420");

  state().setLink(tradesId, "c");
  state().setLink(tradesId, null);
  touchWindow(tradesId);
  const orderId = state().openWindow("order")!;
  expect(state().layout.windows.find((w) => w.id === orderId)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, orderId, windowId("a1"), state().groupSymbols)).toBe("005930");

  resetActiveWindow();
  useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), lastUsedLink: null, groupSymbols: {} });
  const fallbackId = state().openWindow("premarket")!;
  expect(state().layout.windows.find((w) => w.id === fallbackId)?.link).toBeNull();
  const senderFallbackId = state().openWindow("ranking")!;
  expect(state().layout.windows.find((w) => w.id === senderFallbackId)?.link).toBe(DEFAULT_LINK_COLOR);
});

test("새 차트는 활성 창의 연동 색을 상속해 그 그룹의 현재 종목을 따르고, 지표와 명시적 null은 무그룹을 유지한다", () => {
  linked();
  state().openWindow("trades", undefined, { link: "b" });
  touchWindow(windowId("trades"));
  const chartId = state().addChart(windowId("a1"), room)!;
  expect(chartWindow(state().layout, chartId)).toMatchObject({ id: chartId, link: "b", symbol: "035420", period: "D" });

  expect(state().openWindow("indicators")).toBe("indicators");
  expect(state().layout.windows.find((w) => w.id === "indicators")?.link).toBeNull();

  const explicitTrades = state().openWindow("trades", undefined, { link: null })!;
  expect(state().layout.windows.find((w) => w.id === explicitTrades)?.link).toBeNull();
  expect(state().lastUsedLink).toBe("b");

  const explicitChart = state().addChart(windowId("a1"), room, undefined, { link: null })!;
  expect(chartWindow(state().layout, explicitChart)).toMatchObject({ id: explicitChart, link: null, symbol: "005930" });
});

test("십자선 연동 범위를 고르면 켜지고 범위가 정해지며, 끄면 범위는 남고, 같은 값은 저장 순서를 올리지 않는다", () => {
  state().setDock(fittedDock(state().layout));
  const { windows, placement, sync } = state().layout;
  const steps = state().steps;
  const revision = state().revision;
  state().setCrosshairSync(false);
  state().setCrosshairScope("symbol");
  expect(state().layout.sync).toEqual({ crosshair: true, scroll: sync.scroll, crosshairScope: "symbol" });
  expect(state().revision).toBe(revision + 2);
  state().setCrosshairScope("symbol");
  expect(state().revision).toBe(revision + 2);
  state().setCrosshairSync(false);
  expect(state().layout.sync).toEqual({ crosshair: false, scroll: sync.scroll, crosshairScope: "symbol" });
  expect(state().revision).toBe(revision + 3);
  state().setCrosshairScope("symbol");
  expect(state().layout.sync).toEqual({ crosshair: true, scroll: sync.scroll, crosshairScope: "symbol" });
  expect(state().revision).toBe(revision + 4);
  state().setCrosshairScope("link");
  expect(state().layout.sync.crosshairScope).toBe("link");
  expect(state().layout.windows).toBe(windows);
  expect(state().layout.placement).toBe(placement);
  expect(state().steps).toBe(steps);
});

test("배치를 두 번 바꾸고 되돌리기 두 번, 다시 하기 두 번이면 그때마다 창 목록·배치·dockOrigins가 같다", () => {
  state().showWindow("indicators");
  const first = { ...arrangement(), origins: state().dockOrigins };
  expect(state().closeWindow(windowId("screener"))).toBe(true);
  const second = { ...arrangement(), origins: state().dockOrigins };
  state().undoArrangement();
  state().undoArrangement();
  expect(state().redos).toHaveLength(2);
  state().redoArrangement();
  expect({ ...arrangement(), origins: state().dockOrigins }).toEqual(first);
  state().redoArrangement();
  expect({ ...arrangement(), origins: state().dockOrigins }).toEqual(second);
  expect(state().redos).toHaveLength(0);
  expect(state().steps).toHaveLength(2);
  const revision = state().revision;
  state().redoArrangement();
  expect(state().revision).toBe(revision);
});

test("되돌린 뒤 새 배치 변경이나 load는 다시 하기를 비우고, 탭 고르기와 settleDock은 비우지 않는다", () => {
  state().showWindow("indicators");
  state().undoArrangement();
  expect(state().redos).toHaveLength(1);
  state().selectTab(windowId("screener"));
  state().settleDock(fittedDock(state().layout));
  expect(state().redos).toHaveLength(1);
  state().closeWindow(windowId("screener"));
  expect(state().redos).toHaveLength(0);
  state().undoArrangement();
  expect(state().redos).toHaveLength(1);
  state().load(structuredClone(DEFAULT_LAYOUT));
  expect(state().redos).toHaveLength(0);
});

test("창 닫기를 되돌린 뒤 다시 하면 그 창이 다시 닫힌다", () => {
  expect(state().closeWindow(windowId("screener"))).toBe(true);
  state().undoArrangement();
  expect(state().layout.windows.some((w) => w.id === "screener")).toBe(true);
  state().redoArrangement();
  expect(state().layout.windows.some((w) => w.id === "screener")).toBe(false);
  expect(groupOfWindow(state().layout.placement.dock!.root, windowId("screener"))).toBeNull();
});

test("닫기를 되돌린 뒤 남은 차트의 종목을 바꾸고 다시 하면 남은 차트는 바꾼 종목을 유지한다", () => {
  linked();
  expect(state().closeWindow(windowId("a2"))).toBe(true);
  state().undoArrangement();
  state().setSymbol(windowId("a1"), SK);
  state().redoArrangement();
  expect(state().layout.windows.some((w) => w.id === "a2")).toBe(false);
  expect(chartWindows(state().layout).find((w) => w.id === "a1")?.symbol).toBe(SK.code);
});

test("다시 하기로 돌아오는 연동 차트는 지금 같은 색인 차트의 종목을 따른다", () => {
  linked();
  const added = state().addChart(windowId("a1"), room)!;
  state().undoArrangement();
  state().setSymbol(windowId("a1"), SK);
  state().redoArrangement();
  expect(chartWindows(state().layout).find((w) => w.id === added)?.symbol).toBe(SK.code);
  expect(chartWindows(state().layout).find((w) => w.id === "off")?.symbol).toBe("000660");
});

test("빈 배치에서 시작한 기록을 되돌린 뒤 settlePlacement로 처음 배치를 만들고 다시 하면 빈 배치로 돌아가지 않는다", () => {
  useUiStore.getState().setLayoutMode("dock");
  state().load(structuredClone(DEFAULT_LAYOUT));
  const dock = fittedDock(state().layout);
  const floated = detachWindow(dock, windowId("screener"), { x: .2, y: .2, w: .3, h: .4 });
  state().commitDock({ session: state().session, expected: null, next: floated });
  state().undoArrangement();
  expect(state().layout.placement.dock).toBeNull();
  expect(state().redos).toHaveLength(1);
  const settled = { ...state().layout.placement, dock };
  state().settlePlacement(settled);
  state().redoArrangement();
  expect(state().layout.placement.dock).toEqual(floated);
  state().undoArrangement();
  expect(state().layout.placement.dock).toEqual(dock);
});

test(`다시 하기 기록도 최근 ${ARRANGEMENT_STEPS}단계만 남긴다`, () => {
  for (let n = 0; n < ARRANGEMENT_STEPS + 3; n += 1) {
    const dock = fittedDock(state().layout);
    if (dock.root.kind !== "split") throw new Error("기본 배치가 나뉘어 있지 않습니다");
    state().setDock({ ...dock, root: { ...dock.root, ratio: 0.3 + n * 0.01 } });
  }
  for (let n = 0; n < ARRANGEMENT_STEPS + 3; n += 1) state().undoArrangement();
  expect(state().redos).toHaveLength(ARRANGEMENT_STEPS);
});

const rememberedEntry: OrderEntry = { quantity: 37, usedAt: 1 };
const rememberedKeys = () => Object.keys(useUiStore.getState().prefs.orderEntries).sort();
const rememberOrders = (layoutId: string, windowIds: readonly string[]) => {
  for (const id of windowIds) for (const code of ["005930", "000660"]) useUiStore.getState().rememberOrderEntry(orderEntryKey(layoutId, id, code), rememberedEntry);
};
const otherLayoutId = "other-layout";

const reuseOrderTwo = (reuse: () => WindowId | null) => {
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  const layoutId = state().layout.id;
  state().openWindow("order");
  expect(state().duplicateWindow(windowId("order"))).toBe("order-2");
  expect(state().closeWindow(windowId("order-2"))).toBe(true);
  rememberOrders(layoutId, ["order", "order-2"]);
  rememberOrders(otherLayoutId, ["order-2"]);
  expect(rememberedKeys()).toHaveLength(6);
  expect(reuse()).toBe("order-2");
  expect(rememberedKeys()).toEqual([orderEntryKey(layoutId, "order", "000660"), orderEntryKey(layoutId, "order", "005930"), orderEntryKey(otherLayoutId, "order-2", "000660"), orderEntryKey(otherLayoutId, "order-2", "005930")].sort());
};

test("닫은 호가주문창의 id를 복제가 다시 받으면 그 창의 기억만 지운다", () => reuseOrderTwo(() => state().duplicateWindow(windowId("order"))));

test("닫은 호가주문창의 id를 새 창이 다시 받으면 그 창의 기억만 지운다", () => reuseOrderTwo(() => state().openWindow("order")));

test("호가주문창을 닫기만 하면 그 창의 기억은 남는다", () => {
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  state().openWindow("order");
  state().duplicateWindow(windowId("order"));
  rememberOrders(state().layout.id, ["order-2"]);
  expect(state().closeWindow(windowId("order-2"))).toBe(true);
  expect(rememberedKeys()).toHaveLength(2);
});

test("지울 기억이 없으면 창을 열어도 ui 상태를 바꾸지 않는다", () => {
  useUiStore.getState().load(DEFAULT_UI_PREFS, {});
  const before = useUiStore.getState();
  state().openWindow("order");
  state().duplicateWindow(windowId("order"));
  expect(useUiStore.getState()).toBe(before);
});

test("되돌린 호가주문창의 기억은 다시 하기로 새 창이 받을 때 다시 비고 다시 되돌리면 되돌아온다", () => {
  const key = orderEntryKey(state().layout.id, "order-2", "005930");
  const closedEntry = { quantity: 37, usedAt: 1 } as const;
  state().openWindow("order");
  state().duplicateWindow(windowId("order"));
  useUiStore.getState().rememberOrderEntry(key, closedEntry);
  state().closeWindow(windowId("order-2"));
  state().openWindow("order");
  state().undoArrangement();
  state().undoArrangement();
  expect(useUiStore.getState().prefs.orderEntries[key]).toEqual(closedEntry);
  state().redoArrangement();
  state().redoArrangement();
  expect(useUiStore.getState().prefs.orderEntries[key]).toBeUndefined();
  state().undoArrangement();
  state().undoArrangement();
  expect(useUiStore.getState().prefs.orderEntries[key]).toEqual(closedEntry);
});

test("종목 원천이 없는 그룹에서는 새 추종 창에 고아 연동 색을 부여하지 않고 활성 칸을 따르게 한다", () => {
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.windows = layout.windows.map((w) => (w.kind === "chart" ? { ...w, symbol: "005930" } : w));
  useLayoutStore.setState({ layout, lastUsedLink: null, groupSymbols: {} });

  const programId = state().openWindow("program")!;
  expect(state().layout.windows.find((w) => w.id === programId)).toEqual({ id: programId, link: null, kind: "program" });
  expect(linkedWindowSymbol(state().layout, programId, firstChart().id, state().groupSymbols)).toBe("005930");
  expect(state().lastUsedLink).toBeNull();

  const rankingId = state().openWindow("ranking")!;
  expect(state().layout.windows.find((w) => w.id === rankingId)?.link).toBe(DEFAULT_LINK_COLOR);
  touchWindow(rankingId);
  const tradesId = state().openWindow("trades")!;
  expect(state().layout.windows.find((w) => w.id === tradesId)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, tradesId, firstChart().id, state().groupSymbols)).toBe("005930");

  state().setLink(tradesId, "c");
  state().sendSymbolToLink("c", firstChart().id, SK);
  touchWindow(tradesId);
  const bookId = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === bookId)?.link).toBe("c");
  expect(linkedWindowSymbol(state().layout, bookId, firstChart().id, state().groupSymbols)).toBe("000660");
});

test("연동 그룹의 마지막 추종 창이 해제되거나 닫히면 남은 groupSymbols를 정리해 새 추종 창이 고아 색을 받지 않는다", () => {
  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", "a", "005930", "D"),
      { id: windowId("watchlist"), link: null, kind: "watchlist" },
    ],
  });
  state().setLink(windowId("cell-0"), null);
  state().setSymbol(windowId("cell-0"), SK);
  const afterUnlink = state().openWindow("program")!;
  expect(state().layout.windows.find((w) => w.id === afterUnlink)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, afterUnlink, windowId("cell-0"), state().groupSymbols)).toBe("000660");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "b", "000660", "D"),
    ],
  });
  touchWindow(windowId("cell-1"));
  expect(state().closeWindow(windowId("cell-1"))).toBe(true);
  const afterCloseChart = state().openWindow("program")!;
  expect(state().layout.windows.find((w) => w.id === afterCloseChart)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, afterCloseChart, windowId("cell-0"), state().groupSymbols)).toBe("005930");

  const addedChart = state().addChart(windowId("cell-0"), room)!;
  state().setSymbol(addedChart, SK);
  expect(state().closeWindow(addedChart)).toBe(true);
  const afterCloseAdded = state().openWindow("trades")!;
  expect(state().layout.windows.find((w) => w.id === afterCloseAdded)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, afterCloseAdded, windowId("cell-0"), state().groupSymbols)).toBe("005930");

  const tempTrades = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  expect(state().closeWindow(tempTrades)).toBe(true);
  const afterCloseChartless = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === afterCloseChartless)?.link).toBeNull();
  expect(linkedWindowSymbol(state().layout, afterCloseChartless, windowId("cell-0"), state().groupSymbols)).toBe("005930");
});

test("차트 없는 연동 그룹의 추종 창을 닫거나 되돌린 뒤 복원하면 groupSymbols와 연동 상속이 함께 돌아온다", () => {
  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [chart("cell-0", null, "005930", "D")],
  });
  const tradesId = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  expect(state().closeWindow(tradesId)).toBe(true);
  expect(state().groupSymbols.c).toBeUndefined();

  state().undoArrangement();
  expect(linkedWindowSymbol(state().layout, tradesId, windowId("cell-0"), state().groupSymbols)).toBe("000660");
  touchWindow(tradesId);
  const bookId = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === bookId)?.link).toBe("c");
  expect(linkedWindowSymbol(state().layout, bookId, windowId("cell-0"), state().groupSymbols)).toBe("000660");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [chart("cell-0", null, "005930", "D")],
  });
  const reopened = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  state().undoArrangement();
  expect(state().groupSymbols.c).toBeUndefined();
  state().redoArrangement();
  expect(linkedWindowSymbol(state().layout, reopened, windowId("cell-0"), state().groupSymbols)).toBe("000660");
  touchWindow(reopened);
  const programId = state().openWindow("program")!;
  expect(state().layout.windows.find((w) => w.id === programId)?.link).toBe("c");
  expect(linkedWindowSymbol(state().layout, programId, windowId("cell-0"), state().groupSymbols)).toBe("000660");
});

test("되돌리기·다시 하기는 라이브 차트 그룹이나 비운 그룹에 과거 groupSymbols를 덮어쓰지 않는다", () => {
  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", "a", "005930", "D"),
      chart("cell-1", null, "035420", "D"),
    ],
  });
  expect(state().closeWindow(windowId("cell-0"))).toBe(true);
  state().setLink(windowId("cell-1"), "a");
  state().undoArrangement();
  touchWindow(windowId("cell-1"));
  const afterRelinkUndo = state().openWindow("program")!;
  expect(linkedWindowSymbol(state().layout, afterRelinkUndo, windowId("cell-1"), state().groupSymbols)).toBe("035420");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [chart("cell-0", null, "005930", "D")],
  });
  const tradesId = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  expect(state().closeWindow(tradesId)).toBe(true);
  state().setLink(windowId("cell-0"), "c");
  state().undoArrangement();
  expect(linkedWindowSymbol(state().layout, tradesId, windowId("cell-0"), state().groupSymbols)).toBe("005930");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [chart("cell-0", null, "005930", "D")],
  });
  const redoTrades = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  state().undoArrangement();
  state().setLink(windowId("cell-0"), "c");
  state().redoArrangement();
  expect(linkedWindowSymbol(state().layout, redoTrades, windowId("cell-0"), state().groupSymbols)).toBe("005930");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [chart("cell-0", "a", "000660", "D")],
  });
  state().openWindow("indicators");
  state().setLink(windowId("cell-0"), null);
  state().setSymbol(windowId("cell-0"), SAMSUNG);
  state().setLink(windowId("cell-0"), "a");
  state().undoArrangement();
  touchWindow(windowId("cell-0"));
  const afterUnrelatedUndo = state().openWindow("program")!;
  expect(linkedWindowSymbol(state().layout, afterUnrelatedUndo, windowId("cell-0"), state().groupSymbols)).toBe("005930");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      { id: windowId("book"), link: null, kind: "book" },
    ],
  });
  const chartlessTrades = state().openWindow("trades", undefined, { link: "c" })!;
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  state().openWindow("indicators");
  state().setLink(chartlessTrades, null);
  state().setLink(windowId("book"), "c");
  state().undoArrangement();
  expect(state().groupSymbols.c).toBeUndefined();
  expect(linkedWindowSymbol(state().layout, windowId("book"), windowId("cell-0"), state().groupSymbols)).toBeNull();
  touchWindow(windowId("book"));
  const afterEmptyUndo = state().openWindow("program")!;
  expect(state().layout.windows.find((w) => w.id === afterEmptyUndo)?.link).toBeNull();
});

test("차트 복원·잠금 차트 복원·재연동 시 groupSymbols가 손실되지 않고 다중 창 arrange 되돌리기도 보존한다", () => {
  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      { id: windowId("trades"), link: "c", kind: "trades" },
    ],
  });
  state().sendSymbolToLink("c", windowId("cell-0"), SK);
  state().arrange({
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "c", "035420", "D"),
    ],
    placement: { v: 1, dock: null, canvas: null },
  });
  useLayoutStore.setState({ groupSymbols: {} });
  state().undoArrangement();
  expect(state().groupSymbols.c).toBe("000660");
  expect(linkedWindowSymbol(state().layout, windowId("trades"), windowId("cell-0"), state().groupSymbols)).toBe("000660");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "a", "000660", "D"),
    ],
  });
  expect(state().closeWindow(windowId("cell-1"))).toBe(true);
  state().undoArrangement();
  touchWindow(windowId("cell-1"));
  const programId = state().openWindow("program")!;
  expect(state().closeWindow(windowId("cell-1"))).toBe(true);
  expect(linkedWindowSymbol(state().layout, programId, windowId("cell-0"), state().groupSymbols)).toBe("000660");
  touchWindow(programId);
  const bookId = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === bookId)?.link).toBe("a");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "a", "005930", "D"),
    ],
  });
  state().toggleWindowLock(windowId("cell-1"), windowId("cell-0"));
  state().sendSymbolToLink("a", windowId("cell-0"), SK);
  expect(state().closeWindow(windowId("cell-1"))).toBe(true);
  state().undoArrangement();
  touchWindow(windowId("cell-1"));
  const lockedGroupProgram = state().openWindow("program")!;
  expect(linkedWindowSymbol(state().layout, lockedGroupProgram, windowId("cell-0"), state().groupSymbols)).toBe("000660");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "a", "000660", "D"),
    ],
  });
  state().setLink(windowId("cell-1"), null);
  state().setLink(windowId("cell-1"), "a");
  touchWindow(windowId("cell-1"));
  const relinkedProgram = state().openWindow("program")!;
  expect(state().closeWindow(windowId("cell-1"))).toBe(true);
  expect(linkedWindowSymbol(state().layout, relinkedProgram, windowId("cell-0"), state().groupSymbols)).toBe("000660");

  state().load({
    ...structuredClone(DEFAULT_LAYOUT),
    windows: [
      chart("cell-0", null, "005930", "D"),
      chart("cell-1", "a", "000660", "D"),
    ],
  });
  state().setLink(windowId("cell-1"), null);
  const added = state().addChart(windowId("cell-1"), room)!;
  touchWindow(added);
  const addedProgram = state().openWindow("program")!;
  expect(state().closeWindow(added)).toBe(true);
  expect(linkedWindowSymbol(state().layout, addedProgram, windowId("cell-0"), state().groupSymbols)).toBe("000660");
  touchWindow(addedProgram);
  const addedBook = state().openWindow("book")!;
  expect(state().layout.windows.find((w) => w.id === addedBook)?.link).toBe("a");
});

test("정규장만 보기 설정은 값이 바뀔 때만 차트 설정과 저장 순서를 바꾼다", () => {
  const id = firstChart().id;
  const startRevision = state().revision;
  expect(chartWindow(state().layout, id).chartSettings.regularHoursOnly).toBe(false);
  state().setRegularHoursOnly(id, false);
  expect(state().revision).toBe(startRevision);
  state().setRegularHoursOnly(id, true);
  expect(chartWindow(state().layout, id).chartSettings.regularHoursOnly).toBe(true);
  expect(state().revision).toBe(startRevision + 1);
  state().setRegularHoursOnly(id, true);
  expect(state().revision).toBe(startRevision + 1);
  state().setRegularHoursOnly(id, false);
  expect(chartWindow(state().layout, id).chartSettings.regularHoursOnly).toBe(false);
  expect(state().revision).toBe(startRevision + 2);
});

test("캔들을 지표 위에·가격만 축에 맞춤 설정은 값이 바뀔 때만 차트 설정과 저장 순서를 바꾼다", () => {
  const id = firstChart().id;
  const startRevision = state().revision;
  expect(chartWindow(state().layout, id).chartSettings.candlesOnTop).toBe(false);
  expect(chartWindow(state().layout, id).chartSettings.scalePriceOnly).toBe(false);
  state().setCandlesOnTop(id, false);
  state().setScalePriceOnly(id, false);
  expect(state().revision).toBe(startRevision);
  state().setCandlesOnTop(id, true);
  expect(chartWindow(state().layout, id).chartSettings.candlesOnTop).toBe(true);
  expect(state().revision).toBe(startRevision + 1);
  state().setCandlesOnTop(id, true);
  expect(state().revision).toBe(startRevision + 1);
  state().setScalePriceOnly(id, true);
  expect(chartWindow(state().layout, id).chartSettings.scalePriceOnly).toBe(true);
  expect(state().revision).toBe(startRevision + 2);
  state().setScalePriceOnly(id, true);
  expect(state().revision).toBe(startRevision + 2);
  state().setCandlesOnTop(id, false);
  state().setScalePriceOnly(id, false);
  expect(chartWindow(state().layout, id).chartSettings.candlesOnTop).toBe(false);
  expect(chartWindow(state().layout, id).chartSettings.scalePriceOnly).toBe(false);
  expect(state().revision).toBe(startRevision + 4);
});
