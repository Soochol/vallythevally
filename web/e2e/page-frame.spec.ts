import type { Page } from "@playwright/test";
import { serveMarketRankings } from "./fixtures/market-data";
import { cell, expect, test, withFirstChart } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } as const;
const PAGES = [["시장 종합", "/market"], ["히트맵", "/heatmap"], ["ETF", "/etf"]] as const;
const bar = (page: Page) => page.getByRole("toolbar", { name: "페이지 도구 막대" });

for (const [label, path] of PAGES) {
  test(`${label}: 본문은 y=80 안에서 시작하고 위 막대에 주소 조각 없이 페이지 이름이 있다`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("main", { name: label, exact: true })).toBeVisible();
    await expect(bar(page).getByRole("heading", { name: label, level: 1 })).toBeVisible();
    await expect(bar(page).getByLabel("현재 주소")).toHaveCount(0);
    await expect(page.locator(".page-topbar-path")).toHaveCount(0);
    await expect(page.locator(".page-frame-bar")).toHaveCount(0);
    const first = await page.locator(".page-frame-body > *").first().boundingBox();
    expect(first!.y).toBeLessThanOrEqual(80);
    await expect(page.getByRole("link", { name: "작업 영역으로" })).toBeHidden();
  });
}

for (const width of [1280, 1024, 832]) {
  test(`${width}px에서 세 페이지의 위 막대가 가로로 넘치지 않는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, path] of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("main", { name: label, exact: true })).toBeVisible();
      const overflow = await bar(page).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(bar(page).getByRole("button", { name: "종목 찾기" })).toBeVisible();
    }
  });
}

test("페이지에서 종목 찾기로 고르면 보낼 연동 색의 차트가 그 종목을 연다", async ({ page, scenario }) => {
  const layout = scenario.documents.layout();
  const second = { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } as const;
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: [...withFirstChart(layout, { link: "a", symbol: "005930", venue: "combined" }), second] });
  const ui = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...ui, pageLink: "b", revision: ui.revision + 1 });
  serveMarketRankings(scenario);
  await page.goto("/market");
  await expect(page.getByRole("button", { name: "보낼 연동 색: B" })).toBeVisible();
  await bar(page).getByRole("button", { name: "종목 찾기" }).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("삼성물산");
  await dialog.getByRole("option", { name: /삼성물산/ }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: 삼성물산/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
});

test("시세 응답을 붙잡아 60초를 넘기면 신선도가 받지 못함으로 바뀐다", async ({ page, scenario }) => {
  scenario.hold((url) => url.pathname === "/api/market-overview/index");
  await page.clock.install({ time: scenario.now });
  await page.goto("/market");
  const freshness = page.getByRole("status", { name: "자료 신선도" });
  await expect(freshness).toContainText("자료를 기다립니다");
  await expect(freshness).toHaveAttribute("data-tone", "ok");
  await expect(freshness).not.toContainText("받지 못함");
  await page.clock.runFor(61_000);
  await expect(freshness).toContainText("받지 못함 · 마지막 —");
  await expect(freshness).toHaveAttribute("data-tone", "stale");
});

test.describe("390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("페이지 제목 메뉴로 시장 종합에서 히트맵으로 바로 간다", async ({ page }) => {
    await page.goto("/market");
    await expect(page.getByRole("main", { name: "시장 종합", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "시장 종합", exact: true }).click();
    const menu = page.getByRole("menu", { name: "페이지 이동" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["작업 영역", "시장 종합", "히트맵", "ETF"]);
    await expect(menu.getByRole("menuitemradio", { name: "시장 종합" })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: "히트맵" }).click();
    await expect(page).toHaveURL(/\/heatmap$/);
    await expect(page.getByRole("main", { name: "히트맵", exact: true })).toBeVisible();
  });
});
