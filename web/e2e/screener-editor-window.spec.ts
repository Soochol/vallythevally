import type { Screen } from "../src/api/generated/Screen";
import type { Page } from "@playwright/test";
import { type Scenario, expect, test, pollSaved } from "./screener-harness";
import { cell, chartOf, pickDesktopVenue } from "./screener-harness";
import { openScreener, panel, updateBand, waitForUpdateToFinish } from "./screener-page";
import { addCondition, chooseKind, editorWindow, expectKind, expectSentence, numberToken } from "./sentence-editor";

test.use({ viewport: { width: 1440, height: 900 } });

const SEEDED: Screen = { id: "seeded", name: "고가 60일 신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }] };
const SENTENCE = "일봉 최근 20일 이내 고가가 60일 신고가인 봉이 있다";

const editButton = (page: Page) => panel(page).getByRole("button", { name: "편집", exact: true });
const nameField = (page: Page) => editorWindow(page).getByRole("textbox", { name: "조건식 이름", exact: true });
const summary = (page: Page) => panel(page).locator("[data-screen-summary]");
const resultRows = (page: Page) => panel(page).locator("tr[data-code]");
const savedScreens = (scenario: Scenario) => scenario.documents.screens().screens;

async function seed(scenario: Scenario, page: Page) {
  scenario.documents.saveScreens({ screens: [SEEDED], revision: 1 });
  await page.goto("/?symbol=005930");
  await openScreener(page);
  await expect(editButton(page)).toBeVisible();
}

test("패널은 조건 요약 한 줄만 보이고 편집 창은 패널 왼쪽에 떠서 패널을 눌러도 남으며 Esc로 닫으면 편집 버튼으로 돌아온다", async ({ scenario, page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(scenario, page);
  await expect(summary(page)).toHaveText(`코스피 · ETF 제외 · 조건 1개: ${SENTENCE}`);
  await expect(summary(page)).toHaveAttribute("title", `코스피 · ETF 제외\n1. ${SENTENCE}`);
  await expect(panel(page).getByRole("group", { name: "문장형 조건식" })).toHaveCount(0);
  await expect(editButton(page)).toHaveAttribute("aria-expanded", "false");

  await editButton(page).click();
  await expect(editorWindow(page)).toBeVisible();
  await expect(editButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(editorWindow(page).getByRole("group", { name: "문장형 조건식" })).toBeVisible();
  await expect(nameField(page)).toHaveValue(SEEDED.name);
  await expect(editorWindow(page).getByRole("list", { name: "조건" })).toContainText(/신고가\s*일봉\s*최근\s*20일\s*이내에\s*고가가\s*60일\s*최고인\s*봉이 있다/);
  await expect(editorWindow(page).getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스피", exact: true })).toHaveAttribute("aria-pressed", "true");
  const panelBox = (await panel(page).boundingBox())!;
  const windowBox = (await editorWindow(page).boundingBox())!;
  expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(panelBox.x);
  expect(windowBox.x).toBeGreaterThanOrEqual(0);
  expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(900);
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("editor-window.png") });

  await panel(page).click({ position: { x: 4, y: 4 } });
  await expect(editorWindow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(editButton(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(errors).toEqual([]);
});

test("창에서 고친 초안은 닫아도 남고 Ctrl+S로 저장하며 N으로 조건 추가를 연다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await editorWindow(page).getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스닥", exact: true }).click();
  await expect(panel(page).getByText("변경됨", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(panel(page).getByText("변경됨", { exact: true })).toBeVisible();
  await expect(summary(page)).toHaveText(`코스피·코스닥 · ETF 제외 · 조건 1개: ${SENTENCE}`);
  expect((await savedScreens(scenario))[0]!.markets).toEqual(["kospi"]);

  await editButton(page).click();
  await expect(editorWindow(page).getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스닥", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("n");
  const adding = page.getByRole("dialog", { name: "조건 추가", exact: true });
  await expect(adding).toBeVisible();
  await adding.getByRole("textbox", { name: "조건 종류 검색" }).fill("rsi");
  await page.keyboard.press("Enter");
  await expect(editorWindow(page).getByRole("list", { name: "조건" }).getByRole("listitem")).toHaveCount(2);
  await page.keyboard.press("Control+s");
  await pollSaved(async () => (await savedScreens(scenario))[0]).toMatchObject({ markets: ["kospi", "kosdaq"], conditions: [{ kind: "new_high" }, { kind: "rsi" }] });
  await expect(panel(page).getByText("변경됨", { exact: true })).toHaveCount(0);
  await expect(editorWindow(page).getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(editorWindow(page)).toBeVisible();
});

test("창 머리에서 이름을 고치고, 빈 이름으로 실행하면 닫힌 창이 열려 이름 입력에 포커스를 준다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await nameField(page).fill("바꾼 이름");
  await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText("바꾼 이름");

  await nameField(page).fill("");
  await page.keyboard.press("Escape");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(panel(page).getByRole("alert")).toContainText("이름을 넣으세요");
  await page.keyboard.press("Control+Enter");
  await expect(editorWindow(page)).toBeVisible();
  await expect(editorWindow(page).getByRole("alert").first()).toContainText("이름을 넣으세요");
  await expect(nameField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(nameField(page)).toBeFocused();
  expect((await savedScreens(scenario))[0]!.name).toBe(SEEDED.name);
});

test("저장이 처음부터 실패하거나 충돌해도 창과 초안을 지키고 다시 저장하면 반영한다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await nameField(page).fill("로컬 수정");
  let rejected = false;
  scenario.on((url, request) => url.pathname === "/api/screens" && request.method() === "PUT" && !rejected, () => {
    rejected = true;
    return { status: 503, body: { error: { code: "internal", message: "시험용 저장 실패" } } };
  });
  const save = editorWindow(page).getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(editorWindow(page).getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(nameField(page)).toHaveValue("로컬 수정");

  const remote = scenario.documents.screens();
  remote.screens[0]!.exclude = [];
  scenario.documents.saveScreens({ ...remote, revision: remote.revision + 1 });
  await save.click();
  await expect(editorWindow(page).getByRole("alert")).toContainText("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다");
  expect((await savedScreens(scenario))[0]!.name).toBe(SEEDED.name);
  await expect(nameField(page)).toHaveValue("로컬 수정");
  await save.click();
  await pollSaved(async () => (await savedScreens(scenario))[0]!.name).toBe("로컬 수정");
  await expect(editorWindow(page).getByRole("alert")).toHaveCount(0);
  await expect(editorWindow(page)).toBeVisible();
});

test("창 밖 차트 조작은 창을 닫으면서 그대로 실행된다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await expect(editorWindow(page)).toBeVisible();
  await pickDesktopVenue(page, "KRX");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-label", /KRX/);
});

test("저장한 조건식이 없을 때 새 조건식을 누르면 편집 창이 바로 열리고 조건을 넣어 저장한다", async ({ scenario, page }) => {
  await page.goto("/?symbol=005930");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  await expect(editorWindow(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue("새 조건식");
  await expect(editorWindow(page).getByText("조건 없음 · 대상 종목 전체", { exact: true })).toBeVisible();
  await expect(summary(page)).toHaveText("두 시장 · 조건 없음 · 대상 종목 전체");
  await page.keyboard.press("n");
  await page.getByRole("dialog", { name: "조건 추가", exact: true }).getByRole("textbox", { name: "조건 종류 검색" }).fill("신저가");
  await page.keyboard.press("Enter");
  await editorWindow(page).getByRole("button", { name: "저장", exact: true }).click();
  await pollSaved(async () => await savedScreens(scenario)).toMatchObject([{ name: "새 조건식", conditions: [{ kind: "new_low" }] }]);
  await expect(summary(page)).toContainText("두 시장 · 조건 1개: 일봉 최근 1일 이내 저가가 ");
});

test.describe("자료가 있는 저장소", () => {


  test("창을 연 채 창의 실행으로 결과를 받고 결과 행을 눌러 차트를 열어도 창이 남는다", async ({ scenario, page }, info) => {
    const layout = scenario.documents.layout();
    scenario.documents.saveLayout({
      ...layout,
      revision: layout.revision + 1,
      windows: layout.windows.map((w) => (w.kind === "chart" || w.kind === "screener" ? { ...w, link: "a" } : w)),
    });
    scenario.documents.saveScreens({ screens: [{ ...SEEDED, markets: [] }], revision: 1 });
    await page.goto("/");
    await openScreener(page);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await editButton(page).click();
    await editorWindow(page).getByRole("button", { name: "실행", exact: true }).click();
    await expect(resultRows(page)).toHaveCount(4);
    await expect(editorWindow(page)).toBeVisible();
    const first = resultRows(page).first().getByRole("button");
    const name = await first.locator("b").innerText();
    await first.click();
    await expect(first).toHaveAttribute("aria-current", "true");
    await expect(cell(page)).toHaveAttribute("aria-label", new RegExp(`^칸 1: ${name}`));
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
    await expect(editorWindow(page)).toBeVisible();
    if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("editor-with-results.png") });
    await page.keyboard.press("Control+Enter");
    await expect(resultRows(page)).toHaveCount(4);
    await expect(editorWindow(page)).toBeVisible();
  });
});

test("편집 창은 흐림 없는 불투명 면이고 1024×768에서도 위 막대를 덮지 않는다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await expect(editorWindow(page)).toHaveCSS("backdrop-filter", "none");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.reload();
  await openScreener(page);
  await editButton(page).click();
  await expect(editorWindow(page)).toBeVisible();
  const islandBottom = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return parseFloat(style.getPropertyValue("--island-gap")) + parseFloat(style.getPropertyValue("--island-h"));
  });
  const box = (await editorWindow(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(islandBottom);
  expect(box.y + box.height).toBeLessThanOrEqual(768);
});

test("볼린저 조건 문장은 숫자에 기간과 배수 이름을 붙여 읽힌다", async ({ scenario, page }) => {
  scenario.documents.saveScreens({ screens: [{ ...SEEDED, conditions: [{ kind: "bollinger", period: "D", recentBars: 1, length: 20, k: 2, test: { kind: "outside", side: "above" } }] }], revision: 1 });
  await page.goto("/?symbol=005930");
  await openScreener(page);
  await editButton(page).click();
  await expectSentence(editorWindow(page), 1, "볼린저 밴드 일봉 최근 1일 이내에 볼린저 밴드(기간 20, 배수 2)의 상단 위로 벗어난 봉이 있다");
  await expect(numberToken(editorWindow(page), "조건 1 기간")).toHaveAttribute("title", "기간");
  await expect(numberToken(editorWindow(page), "조건 1 표준편차 배수")).toHaveAttribute("title", "표준편차 배수");
});

test("숫자 토큰은 그 자리에서 고쳐 Enter로 적용하고 Esc로 원래 값을 지키며, 일봉 기간의 자주 쓰는 값은 250까지다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  const token = numberToken(editorWindow(page), "조건 1 신고가 기간");
  await expect(token).toHaveText("60");
  const tokenBox = (await token.boundingBox())!;
  await token.click();
  const input = editorWindow(page).getByRole("textbox", { name: "조건 1 신고가 기간", exact: true });
  await expect(input).toBeFocused();
  expect((await input.boundingBox())!.height).toBeCloseTo(tokenBox.height, 0);
  const presets = page.getByRole("dialog", { name: "조건 1 신고가 기간 자주 쓰는 값", exact: true });
  await expect(presets.getByRole("button", { name: "250일", exact: true })).toBeVisible();
  await expect(presets.getByRole("button", { name: "52일", exact: true })).toHaveCount(0);
  await expect(presets.getByRole("button", { name: "적용" })).toHaveCount(0);
  await input.fill("120");
  await input.press("Enter");
  await expect(token).toHaveText("120");
  await expect(token).toBeFocused();
  await expect(editorWindow(page)).toBeVisible();
  await token.click();
  await input.fill("7");
  await input.press("Escape");
  await expect(token).toHaveText("120");
  await expect(editorWindow(page)).toBeVisible();
  await expect(panel(page).getByText("변경됨", { exact: true })).toBeVisible();
});

test("문장 맨 앞 종류 낱말을 눌러 조건 종류를 바꾸고 줄 메뉴는 옮기기·복제·지우기만 둔다", async ({ scenario, page }) => {
  await seed(scenario, page);
  await editButton(page).click();
  await expectKind(editorWindow(page), 1, "new_high");
  await chooseKind(editorWindow(page), 1, "rsi");
  await expectKind(editorWindow(page), 1, "rsi");
  await expectSentence(editorWindow(page), 1, "RSI 일봉 최근 20일 이내에 RSI(14)가 범위 30 이하인 봉이 있다");
  await editorWindow(page).getByRole("button", { name: "조건 1 메뉴", exact: true }).click();
  const menu = page.getByRole("menu", { name: "조건 1 메뉴", exact: true });
  await expect(menu.getByRole("menuitem")).toHaveText(["위로 옮기기", "아래로 옮기기", "복제", "조건 지우기"]);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "복제", exact: true }).click();
  await expect(editorWindow(page).getByRole("list", { name: "조건" }).getByRole("listitem")).toHaveCount(2);
  await expectKind(editorWindow(page), 2, "rsi");
  await addCondition(editorWindow(page), "신저가");
  await expectKind(editorWindow(page), 3, "new_low");
});
