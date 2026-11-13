import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

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

test("분봉 칩을 우클릭하면 위 막대에 꺼내거나 넣고, 꺼낸 주기는 강조 면으로 표시한다", async ({ page }, info) => {
  await open(page);
  await toolbar(page).getByRole("button", { name: "분봉", exact: true }).click();
  const menu = page.getByRole("menu", { name: "분봉", exact: true });
  const five = menu.getByRole("menuitemradio", { name: "5분", exact: true });
  await expect(menu.locator("[data-pinned]")).toHaveCount(0);
  await five.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu.locator("[data-pinned]")).toHaveText(["5분"]);
  await expect(toolbar(page).getByRole("button", { name: "5분 고정 주기", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemcheckbox", { name: "5분 고정", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: info.outputPath("1440-minute-menu.png") });
  await five.click({ button: "right" });
  await expect(toolbar(page).getByRole("button", { name: "5분 고정 주기", exact: true })).toHaveCount(0);
  expect(await menu.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
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
