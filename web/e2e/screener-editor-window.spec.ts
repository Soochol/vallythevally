import type { Page } from "@playwright/test";
import { type App, expect, test } from "./harness";
import { cell, chartOf } from "./harness";
import { openScreener, panel, updateBand, waitForUpdateToFinish } from "./screener-page";
import { editorWindow } from "./sentence-editor";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const SEEDED = { id: "seeded", name: "고가 60일 신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }] };
const SENTENCE = "일봉 최근 20일 이내 고가가 60일 신고가인 봉이 있다";

const editButton = (page: Page) => panel(page).getByRole("button", { name: "편집", exact: true });
const nameField = (page: Page) => editorWindow(page).getByRole("textbox", { name: "조건식 이름", exact: true });
const summary = (page: Page) => panel(page).getByLabel("조건 요약", { exact: true });
const resultRows = (page: Page) => panel(page).locator("tr[data-code]");
const savedScreens = async (app: App) => (await (await fetch(`${app.url}/api/screens`)).json()).screens;

async function seed(app: App, page: Page) {
  const seeded = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [SEEDED], revision: 1 }) });
  expect(seeded.status).toBe(200);
  await page.goto("/?symbol=005930");
  await openScreener(page);
  await expect(summary(page)).toContainText(SENTENCE);
}

test("패널은 요약만 보이고 편집 창은 패널 왼쪽에 떠서 패널을 눌러도 남으며 Esc로 닫으면 편집 버튼으로 돌아온다", async ({ app, page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(app, page);
  await expect(summary(page)).toContainText("코스피 · ETF 제외");
  await expect(panel(page).getByRole("group", { name: "문장형 조건식" })).toHaveCount(0);
  await expect(editButton(page)).toHaveAttribute("aria-expanded", "false");

  await editButton(page).click();
  await expect(editorWindow(page)).toBeVisible();
  await expect(editButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(editorWindow(page).getByRole("group", { name: "문장형 조건식" })).toBeVisible();
  await expect(nameField(page)).toHaveValue(SEEDED.name);
  const panelBox = (await panel(page).boundingBox())!;
  const windowBox = (await editorWindow(page).boundingBox())!;
  expect(windowBox.x + windowBox.width).toBeLessThanOrEqual(panelBox.x);
  expect(windowBox.x).toBeGreaterThanOrEqual(0);
  expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(900);
  await page.screenshot({ path: info.outputPath("editor-window.png") });

  await summary(page).click();
  await expect(editorWindow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(editButton(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(errors).toEqual([]);
});

test("창에서 고친 초안은 닫아도 남고 Ctrl+S로 저장하며 N으로 조건 추가를 연다", async ({ app, page }) => {
  await seed(app, page);
  await editButton(page).click();
  await editorWindow(page).getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스닥", exact: true }).click();
  await expect(panel(page).getByText("변경됨", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(panel(page).getByText("변경됨", { exact: true })).toBeVisible();
  await expect(summary(page)).toContainText("코스피·코스닥 · ETF 제외");
  expect((await savedScreens(app))[0].markets).toEqual(["kospi"]);

  await editButton(page).click();
  await expect(editorWindow(page).getByRole("group", { name: "대상 시장" }).getByRole("button", { name: "코스닥", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("n");
  const adding = page.getByRole("dialog", { name: "조건 추가", exact: true });
  await expect(adding).toBeVisible();
  await adding.getByRole("textbox", { name: "조건 종류 검색" }).fill("rsi");
  await page.keyboard.press("Enter");
  await expect(editorWindow(page).getByRole("list", { name: "조건" }).getByRole("listitem")).toHaveCount(2);
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await savedScreens(app))[0]).toMatchObject({ markets: ["kospi", "kosdaq"], conditions: [{ kind: "new_high" }, { kind: "rsi" }] });
  await expect(panel(page).getByText("변경됨", { exact: true })).toHaveCount(0);
  await expect(editorWindow(page).getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(editorWindow(page)).toBeVisible();
});

test("창 머리에서 이름을 고치고, 빈 이름으로 실행하면 닫힌 창이 열려 이름 입력에 포커스를 준다", async ({ app, page }) => {
  await seed(app, page);
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
  expect((await savedScreens(app))[0].name).toBe(SEEDED.name);
});

test("저장이 처음부터 실패하거나 충돌해도 창과 초안을 지키고 다시 저장하면 반영한다", async ({ app, page }) => {
  await seed(app, page);
  await editButton(page).click();
  await nameField(page).fill("로컬 수정");
  let rejected = false;
  await page.route("**/api/screens", async (route) => {
    if (route.request().method() === "PUT" && !rejected) {
      rejected = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "시험용 저장 실패" }) });
    } else await route.continue();
  });
  const save = editorWindow(page).getByRole("button", { name: "저장", exact: true });
  await save.click();
  await expect(editorWindow(page).getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(nameField(page)).toHaveValue("로컬 수정");

  const remote = await (await fetch(`${app.url}/api/screens`)).json();
  remote.screens[0].exclude = [];
  expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...remote, revision: remote.revision + 1 }) })).ok).toBe(true);
  await save.click();
  await expect(editorWindow(page).getByRole("alert")).toContainText("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다");
  expect((await savedScreens(app))[0].name).toBe(SEEDED.name);
  await expect(nameField(page)).toHaveValue("로컬 수정");
  await save.click();
  await expect.poll(async () => (await savedScreens(app))[0].name).toBe("로컬 수정");
  await expect(editorWindow(page).getByRole("alert")).toHaveCount(0);
  await expect(editorWindow(page)).toBeVisible();
});

test("창 밖 차트 조작은 창을 닫으면서 그대로 실행되고, 넓게 보기는 창 대신 조건을 그 자리에 펼친다", async ({ app, page }) => {
  await seed(app, page);
  await editButton(page).click();
  await expect(editorWindow(page)).toBeVisible();
  await cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: "KRX", exact: true }).click();
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-label", /KRX/);

  await editButton(page).click();
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  await expect(panel(page).getByRole("navigation", { name: "저장한 조건식" })).toBeVisible();
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(editButton(page)).toHaveCount(0);
  await expect(summary(page)).toContainText(SENTENCE);
  await panel(page).getByRole("button", { name: "조건 펼치기", exact: true }).click();
  await expect(panel(page).getByRole("group", { name: "문장형 조건식" })).toBeVisible();
  await expect(editorWindow(page)).toHaveCount(0);
});

test("저장한 조건식이 없을 때 새 조건식을 누르면 편집 창이 바로 열리고 조건을 넣어 저장한다", async ({ app, page }) => {
  await page.goto("/?symbol=005930");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  await expect(editorWindow(page)).toBeVisible();
  await expect(nameField(page)).toHaveValue("새 조건식");
  await expect(summary(page)).toContainText("조건 없음");
  await page.keyboard.press("n");
  await page.getByRole("dialog", { name: "조건 추가", exact: true }).getByRole("textbox", { name: "조건 종류 검색" }).fill("신저가");
  await page.keyboard.press("Enter");
  await editorWindow(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(async () => await savedScreens(app)).toMatchObject([{ name: "새 조건식", conditions: [{ kind: "new_low" }] }]);
  await expect(summary(page)).toContainText("신저가");
});

test.describe("자료가 있는 저장소", () => {
  test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

  test("창을 연 채 창의 실행으로 결과를 받고 결과 행을 눌러 차트를 열어도 창이 남는다", async ({ app, page }, info) => {
    const seeded = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [{ ...SEEDED, markets: [] }], revision: 1 }) });
    expect(seeded.status).toBe(200);
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
    await page.screenshot({ path: info.outputPath("editor-with-results.png") });
    await page.keyboard.press("Control+Enter");
    await expect(resultRows(page)).toHaveCount(4);
    await expect(editorWindow(page)).toBeVisible();
  });
});
