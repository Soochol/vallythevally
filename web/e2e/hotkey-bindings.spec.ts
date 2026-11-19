import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test } from "./harness";
import { drawingDock as dock } from "./drawing-probe";

test.use({ viewport: { width: 1440, height: 900 } });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 50 };
const periodButton = (page: Page, name: string) => page.getByRole("group", { name: "봉 주기", exact: true }).getByRole("button", { name, exact: true });
const pressed = (page: Page, name: string) => expect(dock(page).getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");

function seed(scenario: Scenario, hotkeys: Record<string, string[]>, period: Period = "D") {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period, chartSettings: SETTINGS };
  const root = { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" };
  scenario.documents.saveLayout({ ...layout, windows: [chart], placement: { v: 1, dock: { root, floats: [] }, canvas: null }, revision: layout.revision + 1 });
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, hotkeys, revision: state.revision + 1 } as typeof state);
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await page.mouse.move(5, 5);
}

test("아무것도 바꾸지 않으면 검색 칸 제목과 일 버튼 제목이 지금 단축키를 보인다", async ({ page, scenario }) => {
  seed(scenario, {});
  await open(page);
  await expect(page.getByTitle(SEARCH_BUTTON_TITLE)).toHaveAttribute("title", "종목 검색 (/ 또는 Ctrl+K)");
  await expect(periodButton(page, "일")).toHaveAttribute("title", "일 (D)");
});

test("일을 Q로 바꿔 심으면 Q가 활성 칸을 일로 바꾸고 D는 아무 일도 하지 않는다", async ({ page, scenario }) => {
  seed(scenario, { "period:D": ["KeyQ"] }, "W");
  await open(page);
  await expect(periodButton(page, "일")).toHaveAttribute("title", "일 (Q)");
  await expect(periodButton(page, "주")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("D");
  await page.keyboard.press("BracketRight");
  await expect(periodButton(page, "월")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Q");
  await expect(periodButton(page, "일")).toHaveAttribute("aria-pressed", "true");
});

test("추세선을 없음으로 심으면 T가 추세선 도구를 고르지 않고 도구 막대 제목에 키 글자가 없다", async ({ page, scenario }) => {
  seed(scenario, { "tool:trendline": [] });
  await open(page);
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveAttribute("title", "추세선");
  await cell(page).focus();
  await page.keyboard.press("T");
  await pressed(page, "선택 도구");
  await expect(dock(page).getByRole("button", { name: "추세선", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("R");
  await pressed(page, "사각형");
});

test("피보나치 팬을 Alt+P로 심으면 Alt+P가 피보나치 팬 도구를 고른다", async ({ page, scenario }) => {
  seed(scenario, { "tool:fibfan": ["Alt+KeyP"] });
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("Alt+KeyP");
  await pressed(page, "피보나치 팬");
});
