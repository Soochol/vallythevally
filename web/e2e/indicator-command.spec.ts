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
  const maRow = dialog.getByRole("option").filter({ has: page.getByRole("button", { name: "이동평균 단순 7 설정", exact: true }) });
  await maRow.hover();
  await dialog.getByRole("button", { name: "이동평균 단순 7 숨기기", exact: true }).click();
  const rsiRow = dialog.getByRole("option").filter({ has: page.getByRole("button", { name: "RSI 9 설정", exact: true }) });
  const rsiActions = rsiRow.locator(".ic-row-actions");
  await expect(rsiActions).toHaveCSS("opacity", "0");
  await expect(rsiActions).toHaveCSS("pointer-events", "none");
  await rsiRow.hover();
  await expect(rsiActions).toHaveCSS("opacity", "1");
  await expect(rsiActions).toHaveCSS("pointer-events", "auto");
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

test("입력창 설정 미리보기는 실제 선을 바꾸고 추가 버튼 전에는 저장하지 않으며 Esc는 미리보기를 지운다", async ({ page, scenario }) => {
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
  expect(await settings(scenario)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(customLines).toHaveLength(0);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  expect(await settings(scenario)).toEqual(before);
});

test("지표 창은 탭과 필터 바 없이 카테고리별 부모 추가와 #1/#2 자식 편집을 일관되게 지원한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  await expect(dialog.getByRole("tab")).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "지표 분류" })).toHaveCount(0);
  for (const group of ["가격 패널", "아래 패널", "호가지표", "재무지표"]) {
    await expect(dialog.getByRole("listbox")).toContainText(group);
  }
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();

  await dialog.getByRole("option", { name: "볼린저 밴드 20 2 추가 후보", exact: true }).click();
  await expect(dialog).toContainText("새 인스턴스 #1");
  await dialog.getByRole("button", { name: "볼린저 밴드 20 2 추가", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "bollinger"]);
  await expect(dialog.getByRole("button", { name: "볼린저 밴드 20 2 설정", exact: true })).toBeVisible();
  await expect(dialog).toContainText("자동 저장됨");

  await dialog.getByRole("option", { name: "볼린저 밴드 20 2 추가 후보", exact: true }).click();
  await expect(dialog).toContainText("새 인스턴스 #2");
  await dialog.getByRole("textbox", { name: "표준편차 배수", exact: true }).fill("2.5");
  await dialog.getByRole("button", { name: "볼린저 밴드 20 2.5 추가", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.filter((i) => i.spec.kind === "bollinger").map((i) => i.spec)).toEqual([
    { kind: "bollinger", period: 20, k: 2 },
    { kind: "bollinger", period: 20, k: 2.5 },
  ]);
  await expect(dialog.getByRole("button", { name: "볼린저 밴드 20 2 설정", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "볼린저 밴드 20 2.5 설정", exact: true })).toBeVisible();

  await dialog.getByRole("option", { name: "이동평균 단순 20 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "이동평균 단순 20 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "이동평균 단순 20 추가 후보", exact: true }).click();
  await dialog.getByRole("textbox", { name: "기간", exact: true }).fill("60");
  await dialog.getByRole("button", { name: "이동평균 단순 60 추가", exact: true }).click();
  await dialog.getByRole("button", { name: "이동평균 단순 20 설정", exact: true }).click();
  await dialog.getByRole("textbox", { name: "기간", exact: true }).fill("15");
  await pollSaved(async () => (await settings(scenario)).indicators.filter((i) => i.spec.kind === "ma").map((i) => i.spec)).toEqual([
    { kind: "ma", method: "sma", period: 15 },
    { kind: "ma", method: "sma", period: 60 },
  ]);

  await dialog.getByRole("button", { name: "이동평균 인스턴스 접기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이동평균 단순 15 설정", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "이동평균 인스턴스 펼치기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이동평균 단순 15 설정", exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume"]);
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(dialog.getByRole("tab")).toHaveCount(0);
  await expect(dialog).toContainText("비교 종목");
  await expect(dialog).toContainText("0/3");
});

test("지표 창 선택 행은 왼쪽 세로 막대 없이 배경으로 구분되고 단순·지수 토글은 은은한 테두리를 쓴다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });

  const selectedCurrent = dialog.getByRole("option", { selected: true });
  expect(await selectedCurrent.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");

  await dialog.getByRole("option", { name: "이동평균 단순 20 추가 후보", exact: true }).click();
  const selectedAdd = dialog.getByRole("option", { selected: true });
  expect(await selectedAdd.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");

  const methodGroup = dialog.getByRole("group", { name: "계산 방식", exact: true });
  const borderInfo = await methodGroup.evaluate((el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement("div");
    probe.style.borderColor = "var(--line)";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return { actual: style.borderTopColor, expected, text: style.color };
  });
  expect(borderInfo.actual).toBe(borderInfo.expected);
  expect(borderInfo.actual).not.toBe(borderInfo.text);

  await dialog.getByRole("option", { name: "RSI 14 추가 후보", exact: true }).click();
  expect((await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume"]);
  await dialog.getByRole("button", { name: "RSI 14 추가", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "rsi"]);
  await expect(dialog.getByRole("button", { name: "RSI 14 설정", exact: true })).toBeVisible();
});

test("통합 지표 트리에서 탭 전환 없이 적용된 지표와 새 지표를 함께 검색한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });

  await input.fill("거래량");
  await expect(dialog.getByRole("option", { name: "거래량 추가 후보", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toBeVisible();

  await input.fill("rsi 14");
  await expect(dialog.getByRole("button", { name: "거래량 설정", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("option", { name: "RSI 14 추가 후보", exact: true })).toBeVisible();
});

test("우측 도킹은 도킹 내부 드릴인 상세 전환과 퀵 추가를 지원한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  await input.fill("이평 20");
  await input.press("Enter");
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "ma"]);

  await dialog.getByRole("button", { name: "차트 오른쪽에 도킹", exact: true }).click();
  const dock = page.getByRole("complementary", { name: "차트 우측 설정 패널" });
  const detail = dock.getByRole("region", { name: "지표 상세 설정" });
  await expect(dock).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: "이동평균", exact: true })).toBeVisible();

  const switcher = detail.getByRole("group", { name: "지표 빠른 전환" });
  await switcher.getByRole("button", { name: "거래량", exact: true }).click();
  await expect(detail.getByRole("heading", { name: "거래량", exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "상세 설정 닫기", exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(dock).toBeVisible();

  const quickAdd = dock.getByRole("combobox", { name: "지표 빠른 추가" });
  await quickAdd.click();
  await dock.getByRole("button", { name: "60", exact: true }).click();
  await expect(detail.getByRole("heading", { name: "이동평균선", exact: true })).toBeVisible();

  await pollSaved(async () => (await settings(scenario)).indicators.filter((i) => i.spec.kind === "ma").map((i) => i.spec)).toEqual([
    { kind: "ma", method: "sma", period: 20 },
    { kind: "ma", method: "sma", period: 60 },
  ]);

  await detail.getByRole("button", { name: "상세 설정 닫기", exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(dock).toBeVisible();
  expect(errors).toEqual([]);
});

test("차트 창 헤더 버튼으로 우측 고정 도킹을 1클릭 토글하고 퀵 추가·상세·비교·삭제 되돌리기가 동작한다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const openBtn = page.getByRole("button", { name: "지표 레이어 열기", exact: true });
  await expect(openBtn).toBeVisible();
  const btnBox = (await openBtn.boundingBox())!;
  const cellBox = (await cell(page).boundingBox())!;
  expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(cellBox.y + 1);

  await openBtn.click();
  const dock = page.getByRole("complementary", { name: "차트 우측 설정 패널" });
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-layout", "wide");
  await expect(dock.getByRole("button", { name: "가운데 모달로 전환", exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "우측 고정 도킹", exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "글래스 피크로 전환", exact: true })).toHaveCount(0);

  const quickAdd = dock.getByRole("combobox", { name: "지표 빠른 추가" });
  await quickAdd.fill("rsi 14");
  await quickAdd.press("Enter");
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "rsi"]);

  const detail = dock.getByRole("region", { name: "지표 상세 설정" });
  await expect(detail.getByRole("heading", { name: "RSI", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(dock).toBeVisible();

  await dock.getByRole("button", { name: "차트 설정", exact: true }).click();
  await dock.getByRole("button", { name: /^비교 종목/ }).click();
  const compareSearchBox = (await dock.locator(".b3-compare-search").boundingBox())!;
  expect(compareSearchBox.height).toBeLessThanOrEqual(40);

  await dock.getByRole("button", { name: "레이어", exact: true }).click();
  await dock.getByRole("button", { name: "RSI 14 지우기", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume"]);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await pollSaved(async () => (await settings(scenario)).indicators.map((i) => i.spec.kind)).toEqual(["volume", "rsi"]);

  await page.getByRole("button", { name: "지표 레이어 닫기", exact: true }).click();
  await expect(dock).toBeHidden();
  expect(errors).toEqual([]);
});
