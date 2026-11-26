import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseChartSettings } from "../src/chart/settings";
import { installFrameProbe } from "./frame-probe";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario, firstChart, pollSaved } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";

const settings = async (scenario: Scenario) => parseChartSettings(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID)).chartSettings);

test("입력창에서 Enter로 연속 추가하고 Shift+Enter로 닫은 뒤 숨김·삭제·저장을 복원한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
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
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec)).toEqual([
    { kind: "volume", maPeriod: null },
    { kind: "ma", method: "sma", period: 7 },
    { kind: "bollinger", period: 12, k: 2 },
    { kind: "rsi", period: 9, signal: null },
  ]);
  await page.getByRole("button", { name: "지표", exact: true }).click();
  await dialog.getByRole("button", { name: "이동평균 단순 7 숨기기", exact: true }).click();
  await dialog.getByRole("button", { name: "RSI 9 지우기", exact: true }).click();
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => [i.spec.kind, i.visible])).toEqual([["volume", true], ["ma", false], ["bollinger", true]]);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이동평균 단순 7 보이기", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "RSI 9 지우기", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "볼린저 밴드 12 2 설정", exact: true })).toBeVisible();
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") {
    await mkdir(resolve("../target/ux-screens"), { recursive: true });
    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: resolve(`../target/ux-screens/indicator-command-${size.width}x${size.height}.png`) });
    }
  }
});

test("설정 검사기를 받기 전에 누른 Shift+Enter는 검사기가 준비되면 지표를 추가하고 창을 닫는다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  let releaseWasm!: () => void;
  const wasmReleased = new Promise<void>((resolve) => { releaseWasm = resolve; });
  await page.route("**/*.wasm", async (route) => { await wasmReleased; await route.fallback(); });
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  await input.fill("이평 20");
  await expect(dialog).toContainText("미리보기 준비 중");
  await input.press("Shift+Enter");
  releaseWasm();
  await expect(dialog).toBeHidden();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec)).toEqual([
    { kind: "volume", maPeriod: null },
    { kind: "ma", method: "sma", period: 20 },
  ]);
});

test("설정 검사기를 받기 전에 누른 Shift+Enter는 그 뒤 다른 후보로 바꾸면 아무것도 추가하지 않는다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  let releaseWasm!: () => void;
  const wasmReleased = new Promise<void>((resolve) => { releaseWasm = resolve; });
  await page.route("**/*.wasm", async (route) => { await wasmReleased; await route.fallback(); });
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  await input.fill("이평 20");
  await expect(dialog).toContainText("미리보기 준비 중");
  await input.press("Shift+Enter");
  await input.fill("rsi 9");
  releaseWasm();
  await expect(dialog).toContainText("차트에 미리보기 중");
  await expect(dialog).toBeVisible();
  expect((await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume"]);
});

test("입력창에서 값을 바꾸면 자동 저장되고 Esc는 선과 저장값을 이전 상태로 복원한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
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
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec)).toEqual([
    { kind: "volume", maPeriod: null },
    { kind: "ma", method: "sma", period: 11 },
  ]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(customLines).toHaveLength(0);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pollSaved(async () => settings(scenario)).toEqual(before);
});

test("지표 창은 띄운 지표·지표 추가 두 탭으로 열고 통합 이동평균선 편집기와 별도 비교 모드를 지원한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const tab = (name: RegExp) => dialog.getByRole("tab", { name });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  await expect(dialog.getByRole("tab")).toHaveCount(2);
  await expect(tab(/^이 칸에 띄운 지표/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(/^비교 종목$/)).toHaveCount(0);
  await expect(dialog.getByRole("listbox")).toContainText("아래 패널");
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /추가 후보$/ })).toHaveCount(0);
  await input.fill("이평 20");
  await expect(tab(/^지표 추가$/)).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("option", { name: "이동평균 단순 20 추가 후보", exact: true })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "ma"]);
  await input.fill("");
  await expect(dialog.getByRole("listbox")).toContainText("재무지표");
  await tab(/^지표 추가$/).press("ArrowLeft");
  await expect(tab(/^이 칸에 띄운 지표/)).toHaveAttribute("aria-selected", "true");
  await expect(tab(/^이 칸에 띄운 지표/)).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "이 칸에 띄운 지표 2개", exact: true })).toBeVisible();
  await expect(dialog.getByRole("listbox")).toContainText("가격 패널");
  await dialog.getByRole("button", { name: "이동평균선 설정", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "변경 적용", exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "이동평균 단순 20 기간", exact: true }).fill("15");
  await pollSaved(async () => (await settings(scenario)).indicators.find((i) => i.spec.kind === "ma")?.spec).toEqual({ kind: "ma", method: "sma", period: 15 });
  await dialog.getByRole("textbox", { name: "추가할 이동평균 기간", exact: true }).fill("60");
  await dialog.getByRole("button", { name: "이동평균선 추가", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.filter((i) => i.spec.kind === "ma").map((i) => i.spec)).toEqual([
    { kind: "ma", method: "sma", period: 15 },
    { kind: "ma", method: "sma", period: 60 },
  ]);
  await expect(dialog.getByRole("tab", { name: "이 칸에 띄운 지표 2개", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume"]);
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(dialog.getByRole("tab")).toHaveCount(0);
  await expect(dialog).toContainText("비교 종목");
  await expect(dialog).toContainText("0/3");
});
