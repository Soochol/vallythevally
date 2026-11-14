import { beforeEach, expect, test } from "vitest";
import { groupOfWindow, listGroups } from "../layout/dock/tree";
import { windowId } from "../layout/kinds";
import type { LinkColor } from "../api/generated/LinkColor";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { DEFAULT_CHART_SETTINGS } from "../chart/settings";
import { type ChartWindowState, chartWindows, DEFAULT_LAYOUT, fittedDock, nextLink, useLayoutStore, watchedSymbol, type WindowState } from "./layout";

const state = () => useLayoutStore.getState();
const shownTab = (kind: string) => {
  const { windows, placement } = state().layout;
  const id = windows.find((w) => w.kind === kind)?.id;
  return id !== undefined && placement.dock !== null && groupOfWindow(placement.dock.root, id)?.active === id;
};

beforeEach(() => useLayoutStore.setState({ layout: structuredClone(DEFAULT_LAYOUT), revision: 0 }));

test("탭 고르기는 맞춘 배치에 고른 탭을 남기고 저장 순서를 올린다", () => {
  state().selectTab(windowId("screener"));
  expect(shownTab("screener")).toBe(true);
  expect(state().revision).toBe(1);
  state().selectTab(windowId("screener"));
  expect(state().revision).toBe(1);
});

test("창 보이기는 있는 창의 탭을 고르고, 없는 창은 더해 기본 자리의 탭으로 고른다", () => {
  state().showWindow("objects");
  expect(shownTab("objects")).toBe(true);
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
  layout.windows = layout.windows.map((w) => (w.kind === "objects" ? { ...w, id: windowId("indicators") } : w));
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
  ({ id: windowId(id), link, kind: "chart", symbol, venue: symbol.startsWith("IDX:") ? null : "combined", period, chartSettings: DEFAULT_CHART_SETTINGS });

function linked(...extra: WindowState[]) {
  const layout = structuredClone(DEFAULT_LAYOUT);
  layout.windows = [
    chart("a1", "a", "005930", "D"),
    chart("a2", "a", "005930", "W"),
    chart("off", null, "000660", "D"),
    chart("b1", "b", "035420", "5m"),
    { id: windowId("watchlist"), link: null, kind: "watchlist" },
    { id: windowId("screener"), link: null, kind: "screener" },
    { id: windowId("objects"), link: null, kind: "objects" },
    ...extra,
  ];
  useLayoutStore.setState({ layout, revision: 0 });
}

const shown = () => Object.fromEntries(chartWindows(state().layout).map((w) => [w.id, [w.symbol, w.venue, w.period]]));
const SK = { code: "000660", name: "SK하이닉스", nxtEnabled: true };
const SAMSUNG = { code: "005930", name: "삼성전자", nxtEnabled: true };

test("같은 색의 차트 창 하나의 종목을 바꾸면 그 색의 차트가 모두 바뀌고 봉 주기는 각자 그대로다", () => {
  linked();
  const change = state().setSymbol(windowId("a2"), SK);
  expect(shown()).toEqual({
    a1: ["000660", "combined", "D"],
    a2: ["000660", "combined", "W"],
    off: ["000660", "combined", "D"],
    b1: ["035420", "combined", "5m"],
  });
  expect(change).toEqual({ changed: ["a1", "a2"], notice: "연동 A: 차트 2개가 SK하이닉스로 바뀌었습니다" });
  expect(state().revision).toBe(1);
});

test("색이 다른 차트와 색이 꺼진 차트는 함께 바뀌지 않고, 한 창만 바뀌면 알리지 않는다", () => {
  linked();
  expect(state().setSymbol(windowId("off"), SAMSUNG)).toEqual({ changed: ["off"], notice: null });
  expect(state().setSymbol(windowId("b1"), SK)).toEqual({ changed: ["b1"], notice: null });
  expect(shown()).toEqual({
    a1: ["005930", "combined", "D"],
    a2: ["005930", "combined", "W"],
    off: ["005930", "combined", "D"],
    b1: ["000660", "combined", "5m"],
  });
});

test("여러 차트가 함께 바뀐 알림은 받침에 맞는 조사를 쓰고, 이름을 모르면 종목 코드를 쓴다", () => {
  linked();
  expect(state().setSymbol(windowId("a1"), { code: "051910", name: "LG화학", nxtEnabled: false }).notice).toBe("연동 A: 차트 2개가 LG화학으로 바뀌었습니다");
  expect(state().setSymbol(windowId("a1"), { code: "000270", nxtEnabled: false }).notice).toBe("연동 A: 차트 2개가 000270으로 바뀌었습니다");
  expect(state().setSymbol(windowId("a1"), { code: "000270", nxtEnabled: false })).toEqual({ changed: [], notice: null });
});

test("차트의 색을 이미 쓰는 색으로 바꾸면 그 색의 종목을 따르고, 쓰는 차트가 없는 색이면 종목을 그대로 둔다", () => {
  linked();
  state().setLink(windowId("off"), "a");
  expect(state().layout.windows.find((w) => w.id === "off")).toMatchObject({ link: "a", symbol: "005930", venue: "combined", period: "D" });
  state().setLink(windowId("b1"), "c");
  expect(state().layout.windows.find((w) => w.id === "b1")).toMatchObject({ link: "c", symbol: "035420", period: "5m" });
  state().setLink(windowId("b1"), "a");
  expect(shown().b1).toEqual(["005930", "combined", "5m"]);
  expect(state().revision).toBe(3);
});

test("연동 색은 끔 → A → B → C → 끔으로 돌고, 개체 목록과 지표 창에는 붙지 않는다", () => {
  expect([null, "a", "b", "c"].map((l) => nextLink(l as LinkColor | null))).toEqual(["a", "b", "c", null]);
  linked({ id: windowId("indicators"), link: null, kind: "indicators" });
  state().setLink(windowId("objects"), "a");
  state().setLink(windowId("indicators"), "a");
  state().setLink(windowId("watchlist"), "b");
  expect(state().layout.windows.filter((w) => w.kind !== "chart").map((w) => [w.id, w.link])).toEqual([
    ["watchlist", "b"], ["screener", null], ["objects", null], ["indicators", null],
  ]);
  expect(state().revision).toBe(1);
});

test("색 A인 보내는 창이 종목을 보내면 A인 차트만 바뀌고, A인 차트가 없으면 아무것도 바꾸지 않고 알림 문구를 돌려준다", () => {
  linked();
  state().setLink(windowId("watchlist"), "a");
  const revision = state().revision;
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SK)).toEqual({ changed: ["a1", "a2"], notice: "연동 A: 차트 2개가 SK하이닉스로 바뀌었습니다" });
  expect(shown()).toMatchObject({ a1: ["000660", "combined", "D"], a2: ["000660", "combined", "W"], off: ["000660", "combined", "D"], b1: ["035420", "combined", "5m"] });
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SAMSUNG).changed).toEqual(["a1", "a2"]);
  expect(shown().off).toEqual(["000660", "combined", "D"]);

  state().setLink(windowId("screener"), "c");
  const before = state().layout;
  const after = state().revision;
  expect(state().sendSymbol(windowId("screener"), windowId("off"), SK)).toEqual({ changed: [], notice: "연동 C를 따르는 차트가 없습니다. 차트의 연동 색을 C로 맞추세요" });
  expect(state().layout).toBe(before);
  expect(state().revision).toBe(after);
  expect(after).toBeGreaterThan(revision);
});

test("색이 꺼진 보내는 창과 휴대폰 목록은 활성 칸을 바꾸고, 활성 칸에 색이 있으면 그 색의 차트도 함께 바꾼다", () => {
  linked();
  expect(state().sendSymbol(windowId("watchlist"), windowId("off"), SAMSUNG)).toEqual({ changed: ["off"], notice: null });
  expect(state().sendSymbol(null, windowId("b1"), SAMSUNG)).toEqual({ changed: ["b1"], notice: null });
  expect(state().sendSymbol(windowId("screener"), windowId("a2"), SK).changed).toEqual(["a1", "a2"]);
  expect(shown()).toEqual({
    a1: ["000660", "combined", "D"],
    a2: ["000660", "combined", "W"],
    off: ["005930", "combined", "D"],
    b1: ["005930", "combined", "5m"],
  });
});

test("지수로 바뀌면 그 색의 모든 차트에서 거래소가 없어지고, 주식으로 바뀌면 각 차트의 거래소를 지금 규칙대로 정한다", () => {
  linked();
  state().setVenue(windowId("a2"), "nxt");
  state().setSymbol(windowId("a1"), { code: "IDX:001", nxtEnabled: false });
  expect([shown().a1, shown().a2]).toEqual([["IDX:001", null, "D"], ["IDX:001", null, "W"]]);
  state().setSymbol(windowId("a1"), SAMSUNG);
  expect([shown().a1, shown().a2]).toEqual([["005930", "combined", "D"], ["005930", "combined", "W"]]);
  state().setVenue(windowId("a1"), "krx");
  state().setVenue(windowId("a2"), "nxt");
  state().setSymbol(windowId("a1"), { code: "005935", name: "삼성전자우", nxtEnabled: false });
  expect([shown().a1, shown().a2]).toEqual([["005935", "krx", "D"], ["005935", "combined", "W"]]);
});

test("보내는 창이 보고 있는 종목은 자기 색의 차트 종목이고, 색이 꺼져 있으면 활성 칸의 종목, 그 색의 차트가 없으면 없다", () => {
  linked();
  const layout = () => state().layout;
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"))).toBe("035420");
  expect(watchedSymbol(layout(), null, windowId("off"))).toBe("000660");
  state().setLink(windowId("watchlist"), "a");
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"))).toBe("005930");
  state().setLink(windowId("watchlist"), "c");
  expect(watchedSymbol(layout(), windowId("watchlist"), windowId("b1"))).toBeNull();
});

test("색을 맞춘 차트는 종목 정보가 NXT를 허락하면 자기 NXT를 지키고, 정보를 모르면 앞선 차트가 NXT일 때만 지킨다", () => {
  linked();
  state().setVenue(windowId("off"), "nxt");
  state().setLink(windowId("off"), "a", (code) => (code === "005930" ? true : undefined));
  expect(shown().off).toEqual(["005930", "nxt", "D"]);
  state().setVenue(windowId("b1"), "nxt");
  state().setLink(windowId("b1"), "a");
  expect(shown().b1).toEqual(["005930", "combined", "5m"]);
});

test("주소로 연 거래소는 활성 칸에만 쓰고, 같은 색의 다른 차트는 자기 거래소를 지금 규칙대로 정한다", () => {
  linked();
  state().setVenue(windowId("a2"), "nxt");
  state().setSymbol(windowId("a1"), SK, "krx");
  expect([shown().a1, shown().a2]).toEqual([["000660", "krx", "D"], ["000660", "nxt", "W"]]);
});
