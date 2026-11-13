import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseChartSettings } from "../src/chart/settings";
import { installFrameProbe } from "./frame-probe";
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
  await search(page).fill("삼성SDI");
  const sdi = inspector(page).getByRole("button", { name: /^삼성SDI/ }).first();
  await expect(sdi).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(sdi).toHaveAttribute("aria-pressed", "false");
  await expect(inspector(page).getByRole("button", { name: "비교 종목 추가", exact: true })).toBeDisabled();
  await search(page).press("Enter");
  await expect(sdi).toHaveAttribute("aria-pressed", "false");
  expect(parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings).compare).toEqual([]);
  await sdi.click();
  await expect(sdi).toHaveAttribute("aria-pressed", "true");
  await inspector(page).getByRole("button", { name: /^삼성SDI.*추가$/ }).click();
  await expect.poll(() => parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings).compare).toEqual(["006400"]);
  await expect(inspector(page).getByText("비교 종목 1/3")).toBeVisible();
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

test("인스펙터의 추가 후보 미리보기는 접거나 Esc를 누르거나 탭을 바꾸면 지운다", async ({ page, scenario }) => {
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector" });
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = indicators(scenario);
  const previews = () => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Custom" && s.data.length > 0).length);
  await expect.poll(previews).toBe(0);
  await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await search(page).fill("이평 7");
  await expect.poll(previews).toBe(1);
  await page.keyboard.press("Escape");
  await expect.poll(previews).toBe(0);
  await inspector(page).getByRole("button", { name: "이동평균 단순 7 추가 후보", exact: true }).click();
  await expect.poll(previews).toBe(1);
  await inspector(page).getByRole("button", { name: "이동평균 단순 7 추가 후보", exact: true }).click();
  await expect.poll(previews).toBe(0);
  await search(page).fill("이평 8");
  await expect.poll(previews).toBe(1);
  await inspector(page).getByRole("tab", { name: /^이 칸에 띄운 지표/ }).click();
  await expect.poll(previews).toBe(0);
  expect(indicators(scenario)).toEqual(before);
});

test("인스펙터는 설정칸의 Enter로 추가하고, 펼친 지표를 범례에서 지우면 아무 줄도 펼치지 않으며, 닫기는 패널을 접고 레일로 초점을 옮긴다", async ({ page, scenario }) => {
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector" });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const opener = topbar(page).getByRole("button", { name: "지표", exact: true });
  await expect(opener).not.toHaveAttribute("aria-haspopup", "dialog");
  await opener.click();
  await expect(dialog(page)).toHaveCount(0);
  await search(page).fill("이평 7");
  const period = inspector(page).getByRole("group", { name: "이동평균 추가 설정", exact: true }).getByRole("textbox", { name: "기간", exact: true });
  await period.fill("11");
  await period.press("Enter");
  await expect.poll(async () => indicators(scenario).map((i) => i.spec)).toContainEqual({ kind: "ma", method: "sma", period: 11 });
  await search(page).fill("이평 13");
  await search(page).press("Enter");
  await expect.poll(async () => indicators(scenario).filter((i) => i.spec.kind === "ma").length).toBe(2);

  await inspector(page).getByRole("tab", { name: /^이 칸에 띄운 지표/ }).click();
  const first = inspector(page).getByRole("button", { name: "이동평균 단순 11 설정", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  const id = indicators(scenario).find((i) => i.spec.kind === "ma" && i.spec.period === 11)!.id;
  const legendRow = cell(page).locator(`[data-indicator-row="${id}"]`);
  await legendRow.hover();
  await legendRow.getByRole("button", { name: /지우기$/ }).click();
  await expect.poll(async () => indicators(scenario).map((i) => i.id)).not.toContain(id);
  await expect(inspector(page).getByRole("button", { name: "이동평균 단순 13 설정", exact: true })).toBeVisible();
  await expect(inspector(page).locator('[aria-expanded="true"]')).toHaveCount(0);

  await search(page).focus();
  await page.keyboard.press("Tab");
  const close = inspector(page).getByRole("button", { name: "지표 패널 닫기", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveCount(0);
  await expect(rail(page).getByRole("tab", { name: "지표", exact: true })).toBeFocused();
  await expect.poll(() => scenario.documents.uiState().watchCollapsed).toBe(true);
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
