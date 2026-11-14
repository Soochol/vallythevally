import type { Page } from "@playwright/test";
import { cell, expect, test, firstChart, withFirstChart } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const chartMenu = (page: Page) => page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
const drawings = (page: Page) => cell(page).locator("[data-drawings]").evaluate((node) => JSON.parse((node as HTMLElement).dataset.drawings ?? "[]") as { tool: string }[]);

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function openChartMenu(page: Page, across = 0.4, down = 0.45) {
  const box = (await cell(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * across, box.y + box.height * down, { button: "right" });
  await expect(chartMenu(page)).toBeVisible();
}

test("차트 우클릭은 누른 가격과 날짜를 머리에 두고 차트 동작을 먼저 보이며 붙일 것이 없으면 붙여넣기를 숨긴다", async ({ page }, info) => {
  await open(page);
  await openChartMenu(page, 0.9);
  await expect(chartMenu(page)).toContainText(/[\d,]+ · \d{4}-\d{2}-\d{2}/);
  await page.keyboard.press("Escape");
  await openChartMenu(page);
  await expect(chartMenu(page).getByRole("presentation").first()).toHaveText(/^[\d,]+( · \d{4}-\d{2}-\d{2})?$/);
  await expect(chartMenu(page).getByRole("menuitem")).toHaveText([/이 가격에 수평선/, /관심종목에 넣기/, /축 자동 맞춤/, /차트 이미지 복사/, /이 종목 드로잉 모두 지우기…/]);
  await expect(chartMenu(page).getByRole("menuitem", { name: "붙여넣기" })).toHaveCount(0);
  await expect(chartMenu(page)).toContainText("드로잉 0개");
  await expect(chartMenu(page).getByRole("menuitem", { name: /이 종목 드로잉 모두 지우기/ })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("1440-chart-menu.png") });

  await chartMenu(page).getByRole("menuitem", { name: /이 가격에 수평선/ }).click();
  await expect.poll(async () => (await drawings(page)).map((d) => d.tool)).toEqual(["hline"]);

  await openChartMenu(page, 0.4, 0.6);
  await expect(chartMenu(page)).toContainText("드로잉 1개");
  await chartMenu(page).getByRole("menuitem", { name: /관심종목에 넣기/ }).click();
  await expect(page.getByRole("complementary", { name: "관심종목" }).locator("li[data-code='005930']")).toBeVisible();
  await openChartMenu(page, 0.4, 0.6);
  await expect(chartMenu(page).getByRole("menuitem", { name: /관심종목에 넣기/ })).toBeDisabled();
  await chartMenu(page).getByRole("menuitem", { name: /이 종목 드로잉 모두 지우기/ }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
});

test("분봉 버튼은 마지막 분봉으로 바로 바꾸고, 분봉일 때 다시 누르면 단축키를 적은 세로 목록을 연다", async ({ scenario, page }, info) => {
  await open(page);
  const minutes = toolbar(page).getByRole("button", { name: "분봉", exact: true });
  const menu = page.getByRole("menu", { name: "분봉", exact: true });
  await expect(minutes).toHaveText("3분");
  await expect(minutes).toHaveAttribute("aria-pressed", "false");
  await minutes.click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 3분$/);
  await expect(minutes).toHaveAttribute("aria-pressed", "true");
  await expect(menu).toBeHidden();

  await minutes.click();
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitemradio");
  await expect(items).toHaveText(["1분1", "3분3", "5분5", "10분", "15분Shift+1", "30분Shift+3", "60분Shift+6"]);
  await expect(menu.getByRole("menuitemradio", { name: "3분", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "30분", exact: true })).toHaveAttribute("aria-keyshortcuts", "Shift+3");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(0);
  const boxes = await Promise.all((await items.all()).map((item) => item.boundingBox()));
  for (const [i, box] of boxes.entries()) {
    expect(box!.x).toBe(boxes[0]!.x);
    if (i > 0) expect(box!.y).toBeGreaterThan(boxes[i - 1]!.y + box!.height / 2);
  }
  expect(await menu.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath("1440-minute-menu.png") });
  await menu.getByRole("menuitemradio", { name: "10분", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(cell(page)).toHaveAttribute("aria-label", / 10분$/);

  await toolbar(page).getByRole("button", { name: "일", exact: true }).click();
  await expect(minutes).toHaveText("10분");
  await expect(minutes).toHaveAttribute("aria-pressed", "false");
  await minutes.click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 10분$/);
  await expect(menu).toBeHidden();

  await page.keyboard.press("Shift+Digit6");
  await expect(cell(page)).toHaveAttribute("aria-label", / 60분$/);
  await page.keyboard.press("KeyD");
  await expect(cell(page)).toHaveAttribute("aria-label", / 일$/);
  await expect(minutes).toHaveText("60분");
  await expect.poll(async () => scenario.documents.uiState().lastMinute).toBe("60m");
  await page.reload();
  await expect(minutes).toHaveText("60분");
  await minutes.click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 60분$/);
});

test("옛 저장값의 고정 분봉은 꺼내지 않고 버리며, 열 때 활성 칸의 분봉을 마지막 분봉으로 저장한다", async ({ scenario, page }) => {
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, pinnedMinutes: ["5m", "60m"], recentSymbols: ["005930"], revision: state.revision + 1 });
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "10m" }) });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const minutes = toolbar(page).getByRole("button", { name: "분봉", exact: true });
  await expect(toolbar(page).getByRole("group", { name: "봉 주기" }).getByRole("button")).toHaveText(["10분", "일", "주", "월", "분기", "연"]);
  await expect(minutes).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => scenario.documents.uiState().lastMinute).toBe("10m");
  expect(scenario.documents.uiState()).not.toHaveProperty("pinnedMinutes");
  await toolbar(page).getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", / 일$/);
  await expect.poll(async () => firstChart(scenario.documents.layout()).period).toBe("D");
  await page.reload();
  await expect(minutes).toHaveText("10분");
  await expect(minutes).toHaveAttribute("aria-pressed", "false");
});

test("지표 설정은 색 격자·굵기 견본·기간 프리셋을 한 장에 두고 바로 적용하며 머리에서 숨기고 지운다", async ({ page }, info) => {
  await open(page);
  await toolbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await page.keyboard.type("이평 20");
  await page.keyboard.press("Shift+Enter");
  await cell(page).getByRole("button", { name: "이동평균 단순 20 설정", exact: true }).first().click();
  const settings = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  await expect(settings.getByRole("group", { name: "색상표" }).getByRole("button")).toHaveCount(40);
  const mint = settings.getByRole("button", { name: "청록 #5FCDB8", exact: true });
  await mint.click();
  await expect(mint).toHaveAttribute("aria-pressed", "true");
  await expect(settings.getByRole("group", { name: "선 색상", exact: true })).toContainText("#5FCDB8");
  await settings.getByRole("group", { name: "굵기", exact: true }).getByRole("button", { name: "3", exact: true }).click();
  await settings.getByRole("group", { name: "자주 쓰는 기간" }).getByRole("button", { name: "60", exact: true }).click();
  await expect(cell(page).getByRole("button", { name: "이동평균 단순 60 설정", exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("1440-indicator-settings.png") });
  expect(await page.getByRole("dialog").count()).toBe(1);

  await settings.getByRole("button", { name: "지표 숨기기", exact: true }).click();
  await expect(settings.getByRole("button", { name: "지표 보이기", exact: true })).toHaveAttribute("aria-pressed", "true");
  await settings.getByRole("button", { name: "지표 지우기", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(cell(page).getByRole("button", { name: /이동평균 단순 \d+ 설정/ })).toHaveCount(0);
});
