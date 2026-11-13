import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseChartSettings } from "../src/chart/settings";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./harness";

const indicators = (scenario: Scenario) => parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings).indicators;
const maColors = async (scenario: Scenario) => indicators(scenario).filter((i) => i.spec.kind === "ma").map((i) => i.style.colors);
const rail = (page: Page) => page.getByRole("tablist", { name: "오른쪽 패널" });
const inspector = (page: Page) => page.getByRole("region", { name: "지표", exact: true });
const search = (page: Page) => inspector(page).getByRole("searchbox", { name: "지표·비교 찾기" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "지표·비교 입력창" });
const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });

async function chooseWindow(page: Page, label: "가운데 창" | "차트 옆") {
  await topbar(page).getByRole("button", { name: "차트 설정", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "차트 설정", exact: true });
  const choice = popover.getByRole("group", { name: "지표 창" }).getByRole("button", { name: label, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
}

test("차트 옆을 고르면 지표 버튼이 우측 패널을 열어 지표를 추가·편집하고, 되돌리면 관심종목과 가운데 창으로 돌아간다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toHaveCount(0);

  await chooseWindow(page, "차트 옆");
  await expect.poll(() => scenario.documents.uiState().indicatorWindow).toBe("inspector");
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toBeVisible();
  await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(search(page)).toBeFocused();
  await expect(inspector(page).getByRole("tab", { name: /^이 칸에 띄운 지표/ })).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("button", { name: "거래량 설정", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => scenario.documents.uiState().rightPanel).toBe("indicators");

  await search(page).fill("이평 9");
  await expect(inspector(page).getByRole("tab", { name: "지표 추가", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("button", { name: "이동평균 단순 9 추가 후보", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(inspector(page).getByRole("img", { name: "선 미리보기" })).toHaveCount(0);
  await inspector(page).getByRole("button", { name: "이동평균 단순 9 추가", exact: true }).click();
  await expect.poll(async () => indicators(scenario).map((i) => i.spec)).toContainEqual({ kind: "ma", method: "sma", period: 9 });
  await search(page).fill("rsi");
  await search(page).press("Enter");
  await expect.poll(async () => indicators(scenario).map((i) => i.spec.kind)).toEqual(["volume", "ma", "rsi"]);

  await inspector(page).getByRole("tab", { name: /^이 칸에 띄운 지표/ }).click();
  const ma = inspector(page).getByRole("button", { name: "이동평균 단순 9 설정", exact: true });
  await ma.click();
  await expect(ma).toHaveAttribute("aria-expanded", "true");
  const editor = inspector(page).getByRole("group", { name: "이동평균 단순 9 설정", exact: true });
  await editor.getByRole("group", { name: "색상표", exact: true }).getByRole("button", { name: "분홍 #EE9DD0", exact: true }).click();
  await expect.poll(() => maColors(scenario)).toEqual([["#EE9DD0"]]);
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  await page.screenshot({ path: resolve("../target/ux-screens/indicator-inspector-open-1440x900.png") });
  await ma.click();
  await expect(ma).toHaveAttribute("aria-expanded", "false");
  await ma.click();
  await editor.getByRole("group", { name: "테마 색", exact: true }).getByRole("button", { name: /^테마 1 / }).click();
  await expect.poll(() => maColors(scenario)).toEqual([["ind-1"]]);
  await page.keyboard.press("Escape");
  await expect.poll(() => maColors(scenario)).toEqual([["#EE9DD0"]]);
  await expect(ma).toHaveAttribute("aria-expanded", "false");
  await expect(search(page)).toBeFocused();

  await rail(page).getByRole("tab", { name: "관심종목", exact: true }).click();
  await expect(inspector(page)).toHaveCount(0);
  await cell(page).getByRole("button", { name: "RSI 14 설정", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "RSI 14 설정", exact: true })).toHaveCount(0);
  await expect(inspector(page).getByRole("button", { name: "RSI 14 설정", exact: true })).toHaveAttribute("aria-expanded", "true");
  await rail(page).getByRole("tab", { name: "관심종목", exact: true }).click();
  await cell(page).focus();
  await page.keyboard.press("i");
  await expect(search(page)).toBeFocused();
  await page.screenshot({ path: resolve("../target/ux-screens/indicator-inspector-1440x900.png") });

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("button", { name: "이동평균 단순 9 설정", exact: true })).toBeVisible();
  await topbar(page).getByRole("button", { name: "비교", exact: true }).click();
  await expect(inspector(page).getByRole("tab", { name: "비교 종목", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByText("비교 종목 0/3")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);

  await chooseWindow(page, "가운데 창");
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toHaveCount(0);
  await expect(rail(page).getByRole("tab", { name: "관심종목", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => [scenario.documents.uiState().indicatorWindow, scenario.documents.uiState().rightPanel]).toEqual(["dialog", "watch"]);
  await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rail(page).getByRole("tab", { name: "관심종목", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toHaveCount(0);
});

test.describe("휴대폰", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("차트 옆 방식으로 저장돼 있어도 휴대폰의 지표 버튼은 가운데 창을 연다", async ({ page, scenario }) => {
    scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector", rightPanel: "indicators" });
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "지표", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(inspector(page)).toHaveCount(0);
  });
});
