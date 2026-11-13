import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseChartSettings } from "../src/chart/settings";
import { installFrameProbe } from "./frame-probe";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./harness";

const settings = async (scenario: Scenario) => parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings);

test("입력창에서 Enter로 연속 추가하고 Shift+Enter로 닫은 뒤 숨김·삭제·저장을 복원한다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await cell(page).focus();
  await page.keyboard.press("i");
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  for (const query of ["이평 7", "bb 12 2"]) {
    await input.fill(query);
    await input.press("Enter");
    await expect(dialog).toBeVisible();
  }
  await input.fill("rsi 9");
  await input.press("Shift+Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await settings(scenario)).indicators.map((i) => i.spec)).toEqual([
    { kind: "volume", maPeriod: null },
    { kind: "ma", method: "sma", period: 7 },
    { kind: "bollinger", period: 12, k: 2 },
    { kind: "rsi", period: 9, signal: null },
  ]);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  await dialog.getByRole("button", { name: "이동평균 단순 7 숨기기", exact: true }).click();
  await dialog.getByRole("button", { name: "RSI 9 지우기", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await settings(scenario)).indicators.map((i) => [i.spec.kind, i.visible])).toEqual([["volume", true], ["ma", false], ["bollinger", true]]);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이동평균 단순 7 보이기", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "RSI 9 지우기", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "볼린저 밴드 12 2 설정", exact: true })).toBeVisible();
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(`../target/ux-screens/indicator-command-${size.width}x${size.height}.png`) });
  }
});

test("입력창 설정 미리보기는 실제 선을 바꾸고 Esc는 선과 저장값을 복원한다", async ({ page, scenario }) => {
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await settings(scenario);
  const customLines = () => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Custom" && s.data.length > 0));
  await expect.poll(customLines).toHaveLength(0);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  await dialog.getByRole("combobox").fill("이평 7");
  await expect.poll(customLines).toHaveLength(1);
  const first = await customLines();
  await dialog.getByRole("textbox", { name: "기간", exact: true }).fill("11");
  await expect.poll(async () => (await customLines())[0]?.data).not.toEqual(first[0]?.data);
  expect(await settings(scenario)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(customLines).toHaveLength(0);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expect(await settings(scenario)).toEqual(before);
});

test("지표 창은 띄운 지표 탭으로 열고 글자를 치면 지표 추가 탭으로 넘어가며 탭으로 비교 종목을 오간다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const tab = (name: RegExp) => dialog.getByRole("tab", { name });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  await expect(tab(/^이 칸에 띄운 지표/)).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("listbox")).toContainText("아래 패널");
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /추가 후보$/ })).toHaveCount(0);
  await input.fill("이평 20");
  await expect(tab(/^지표 추가$/)).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("option", { name: "이동평균 단순 20 추가 후보", exact: true })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect.poll(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "ma"]);
  await input.fill("");
  await expect(dialog.getByRole("listbox")).toContainText("재무지표");
  await tab(/^비교 종목$/).click();
  await expect(input).toBeFocused();
  await expect(dialog).toContainText("비교 종목 0/3");
  await expect(dialog.getByRole("option", { name: /추가 후보$/ })).toHaveCount(0);
  await tab(/^비교 종목$/).press("ArrowLeft");
  await expect(tab(/^지표 추가$/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(/^지표 추가$/)).toBeFocused();
  await tab(/^이 칸에 띄운 지표/).click();
  await expect(tab(/^이 칸에 띄운 지표/)).toContainText("2");
  await expect(dialog.getByRole("listbox")).toContainText("가격 패널");
  await dialog.getByRole("button", { name: "이동평균 단순 20 설정", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "변경 적용", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(tab(/^비교 종목$/)).toHaveAttribute("aria-selected", "true");
});
