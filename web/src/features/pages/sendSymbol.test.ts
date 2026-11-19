import { beforeEach, expect, test } from "vitest";
import { windowId, type WindowId } from "../../layout/kinds";
import { DEFAULT_LAYOUT, chartWindows, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { sendSymbolToLinkedChart } from "./sendSymbol";

const SK = { code: "000660", name: "SK하이닉스" };

function chartsLinked(...links: (null | "a" | "b")[]) {
  const layout = structuredClone(DEFAULT_LAYOUT);
  const [first] = chartWindows(layout);
  layout.windows = links.map((link, i) => ({ ...first!, id: windowId(`c${i}`), link, symbol: "005930" }));
  useLayoutStore.setState({ layout, revision: 0 });
}
const symbols = () => Object.fromEntries(chartWindows(useLayoutStore.getState().layout).map((c) => [c.id, c.symbol]));
const choose = (pageLink: "a" | "b" | null) => useUiStore.setState({ prefs: { ...DEFAULT_UI_PREFS, pageLink } });
const activate = (id: WindowId) => useSelectionStore.setState({ activeCell: id });

beforeEach(() => {
  choose("a");
  activate(windowId("c0"));
});

test("고른 연동 색의 차트에 종목을 열고 작업 영역으로 이동한다", () => {
  chartsLinked(null, "a", "b");
  const visited: string[] = [];
  sendSymbolToLinkedChart(SK, (to) => visited.push(to));
  expect(symbols()).toEqual({ c0: "005930", c1: "000660", c2: "005930" });
  expect(visited).toEqual(["/"]);
});

test("고른 색의 차트가 없으면 활성 차트에 열고, 끔을 골라도 활성 차트에 연다", () => {
  chartsLinked(null, "b");
  const visited: string[] = [];
  sendSymbolToLinkedChart(SK, (to) => visited.push(to));
  expect(symbols()).toEqual({ c0: "000660", c1: "005930" });
  choose(null);
  activate(windowId("c1"));
  sendSymbolToLinkedChart({ code: "035420" }, (to) => visited.push(to));
  expect(symbols()).toEqual({ c0: "000660", c1: "035420" });
  expect(visited).toEqual(["/", "/"]);
});
