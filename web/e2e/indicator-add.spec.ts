import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings } from "../src/chart/settings";
import { cell, DEFAULT_LAYOUT_ID, expect, firstChart, pollSaved, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100030" });

const settings = (scenario: Scenario) => parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings);
const specs = (scenario: Scenario) => settings(scenario).indicators.map((item) => item.spec);
const line = (id: string, spec: object, color: string, panel = "price") => ({ id, spec, panel, visible: true, style: { colors: [color], width: 1 } });
const MA20 = line("m20", { kind: "ma", method: "sma", period: 20 }, "ind-2");
const VOLUME = line("vol", { kind: "volume", maPeriod: null }, "ind-1", "p1");
const RSI = line("rsi", { kind: "rsi", period: 14, signal: null }, "ind-4", "p2");

function seed(scenario: Scenario, indicators: object[], panels: object[] = []) {
  const current: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const { id, name, sync, placement, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels };
  scenario.documents.saveLayout({ id, name, sync, placement, revision: revision + 1, windows: withFirstChart(current, { symbol: "005930", venue: "combined", period: "D", chartSettings }) });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

const row = (page: Page, id: string) => page.locator(`[data-indicator-row="${id}"]`);
const addDialog = (page: Page) => page.getByRole("dialog", { name: "지표 더하기", exact: true });
const addInput = (page: Page) => addDialog(page).getByRole("combobox", { name: "지표·비교 찾기" });
const kindOption = (page: Page, name: string) => addDialog(page).getByRole("option", { name, exact: true });
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });

test("범례의 숫자를 누르면 말풍선이 그 칸에 초점을 주고, 바꾼 값은 바로 차트에 반영된다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await expect(row(page, "m20")).toContainText("이동평균 단순 20");
  await row(page, "m20").locator("[data-indicator-token]").click();
  const bubble = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  const period = bubble.locator('input[data-field="period"]');
  await expect(period).toBeFocused();
  await period.fill("60");
  await expect(row(page, "m20")).toContainText("이동평균 단순 60");
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 60 }]);
});

test("Esc는 말풍선을 닫기만 하고 바꾼 값을 남기며, 처음 값으로는 연 때의 값으로 돌린다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await row(page, "m20").locator("[data-indicator-edit]").click();
  const bubble = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  await expect(bubble.getByRole("button", { name: "처음 값으로", exact: true })).toBeDisabled();
  await bubble.getByRole("group", { name: "자주 쓰는 기간" }).getByRole("button", { name: "120", exact: true }).click();
  await expect(row(page, "m20")).toContainText("이동평균 단순 120");
  await bubble.getByRole("button", { name: "처음 값으로", exact: true }).click();
  await expect(row(page, "m20")).toContainText("이동평균 단순 20");
  await bubble.getByRole("group", { name: "자주 쓰는 기간" }).getByRole("button", { name: "60", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(bubble).toBeHidden();
  await expect(row(page, "m20")).toContainText("이동평균 단순 60");
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 60 }]);
});

test("Ctrl+Z는 말풍선에서 바꾼 지표 설정을 되돌리고 알린다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await row(page, "m20").locator("[data-indicator-edit]").click();
  const bubble = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  await bubble.getByRole("group", { name: "자주 쓰는 기간" }).getByRole("button", { name: "60", exact: true }).click();
  await expect(row(page, "m20")).toContainText("이동평균 단순 60");
  await page.keyboard.press("Escape");
  await expect(bubble).toBeHidden();
  await cell(page).focus();
  await page.keyboard.press("Control+z");
  await expect(row(page, "m20")).toContainText("이동평균 단순 20");
  await expect(page.getByText("지표·차트 설정 변경을 되돌렸습니다")).toBeVisible();
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 20 }]);
});

test("더하기 창의 스위치로 넣고 빼며, 다시 켜면 마지막 설정으로 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await cell(page).locator("[data-indicator-add]").click();
  await expect(addInput(page)).toBeFocused();
  await expect(kindOption(page, "RSI")).toHaveAttribute("aria-selected", "false");
  await kindOption(page, "RSI").click();
  await expect(kindOption(page, "RSI")).toHaveAttribute("aria-selected", "true");
  await expect(addDialog(page)).toBeVisible();
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 20 }, { kind: "rsi", period: 14, signal: null }]);
  await page.keyboard.press("Escape");
  const rsiRow = page.locator("[data-indicator-row]", { hasText: "RSI 14" });
  await rsiRow.locator("[data-indicator-token]").click();
  await page.getByRole("dialog", { name: "RSI 14 설정", exact: true }).locator('input[data-field="period"]').fill("7");
  await page.keyboard.press("Escape");
  await cell(page).locator("[data-indicator-add]").click();
  await kindOption(page, "RSI").click();
  await expect(kindOption(page, "RSI")).toHaveAttribute("aria-selected", "false");
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 20 }]);
  await kindOption(page, "RSI").click();
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 20 }, { kind: "rsi", period: 7, signal: null }]);
});

test("입력으로 숫자까지 적으면 Enter가 그 지표를 더하고 창은 그대로 둔다", async ({ page, scenario }) => {
  seed(scenario, []);
  await open(page);
  await cell(page).focus();
  await page.keyboard.press("i");
  for (const query of ["이평 7", "bb 12 2", "rsi 9"]) {
    await addInput(page).fill(query);
    await addInput(page).press("Enter");
    await expect(addInput(page)).toHaveValue("");
    await expect(addDialog(page)).toBeVisible();
  }
  await pollSaved(() => specs(scenario)).toEqual([
    { kind: "ma", method: "sma", period: 7 },
    { kind: "bollinger", period: 12, k: 2 },
    { kind: "rsi", period: 9, signal: null },
  ]);
  await addInput(page).press("Escape");
  await expect(addDialog(page)).toBeHidden();
  await pollSaved(() => specs(scenario).length).toBe(3);
});

test("이동평균 기간 칩은 켜고 끄는 스위치이고, 하나 더는 같은 지표를 또 넣는다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await cell(page).locator("[data-indicator-add]").click();
  const chips = addDialog(page).getByRole("group", { name: "이동평균 기간" });
  await expect(chips.getByRole("button", { name: "이동평균 20", exact: true })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: "이동평균 60", exact: true }).click();
  await expect(chips.getByRole("button", { name: "이동평균 60", exact: true })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: "이동평균 20", exact: true }).click();
  await expect(chips.getByRole("button", { name: "이동평균 20", exact: true })).toHaveAttribute("aria-pressed", "false");
  await pollSaved(() => specs(scenario)).toEqual([{ kind: "ma", method: "sma", period: 60 }]);
  await addDialog(page).getByRole("button", { name: "이동평균 하나 더", exact: true }).click();
  await pollSaved(() => specs(scenario).map((spec) => spec.kind)).toEqual(["ma", "ma"]);
});

test("위 막대의 지표 단추는 범례의 ＋지표와 같은 창을 열고, 다시 누르면 닫는다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  const button = toolbar(page).getByRole("button", { name: "지표", exact: true });
  await expect(button).toContainText("1");
  await button.click();
  await expect(addDialog(page)).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(kindOption(page, "이동평균")).toHaveAttribute("aria-selected", "true");
  await button.click();
  await expect(addDialog(page)).toBeHidden();
  await cell(page).locator("[data-indicator-add]").click();
  await expect(kindOption(page, "이동평균")).toHaveAttribute("aria-selected", "true");
  await row(page, "m20").locator("[data-indicator-edit]").click();
  await expect(addDialog(page)).toBeHidden();
  await expect(page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true })).toBeVisible();
});

test("범례 머리의 톱니와 위 막대의 차트 단추가 같은 차트 설정을 열고 Esc는 바꾼 값을 남긴다", async ({ page, scenario }) => {
  seed(scenario, [MA20]);
  await open(page);
  await cell(page).locator("[data-chart-settings-open]").click();
  const dialog = page.getByRole("dialog", { name: "차트 설정", exact: true });
  await dialog.getByRole("group", { name: "봉 모양" }).getByRole("button", { name: "라인", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await pollSaved(() => settings(scenario).style).toBe("line");
  await toolbar(page).getByRole("button", { name: "차트 설정", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "봉 모양" }).getByRole("button", { name: "라인", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("말풍선의 자세히에서 패널을 합치고 나누고 Y축을 고른다", async ({ page, scenario }) => {
  seed(scenario, [VOLUME, RSI], [{ id: "p1", stretch: 1 }, { id: "p2", stretch: 1 }]);
  await open(page);
  await row(page, "rsi").locator("[data-indicator-edit]").click();
  const bubble = page.getByRole("dialog", { name: "RSI 14 설정", exact: true });
  await bubble.getByRole("button", { name: /자세히/ }).click();
  await bubble.getByRole("button", { name: "거래량 패널에 합치기", exact: true }).click();
  await pollSaved(() => settings(scenario).indicators.map((item) => item.panel)).toEqual(["p1", "p1"]);
  await bubble.getByRole("group", { name: "Y축" }).getByRole("button", { name: "왼쪽", exact: true }).click();
  await pollSaved(() => settings(scenario).indicators.find((item) => item.id === "rsi")?.axis).toBe("left");
  await bubble.getByRole("group", { name: "패널 자리" }).getByRole("button", { name: "따로", exact: true }).click();
  await pollSaved(() => new Set(settings(scenario).indicators.map((item) => item.panel)).size).toBe(2);
});
