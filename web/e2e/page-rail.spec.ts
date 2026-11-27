import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import { serveMarketRankings } from "./fixtures/market-data";
import { cell, expect, test, withFirstChart, type Scenario } from "./harness";

const SIGNED_OUT: AccountStatus = { state: "signed_out" };
const SIGNED_IN: AccountStatus = { state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000, sync: { state: "running", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } };
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } as const;
const PAGES = [["시장 종합", "/market"], ["히트맵", "/heatmap"], ["ETF", "/etf"], ["호가 복기", "/replay"]] as const;

const rail = (page: Page) => page.getByRole("navigation", { name: "페이지 메뉴" });
const railLink = (page: Page, name: string) => rail(page).getByRole("link", { name, exact: true });
const workspace = (page: Page) => page.getByRole("main", { name: "작업 영역" });
const brand = (page: Page) => page.getByRole("link", { name: "vally", exact: true });
const landing = (page: Page) => page.getByTestId("landing");
const barRequests = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/bars").length;
const unsubscribes = (scenario: Scenario) => scenario.live.messages.filter((m) => m.type === "unsubscribe").length;

test("세로 메뉴의 아이콘을 누르면 그 주소로 이동하고 지금 페이지가 표시된다", async ({ page }) => {
  await page.goto("/");
  await expect(railLink(page, "작업 영역")).toHaveAttribute("aria-current", "page");
  await expect(rail(page).getByRole("button", { name: "단축키" })).toBeVisible();
  for (const [label, path] of PAGES) {
    await railLink(page, label).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("main", { name: label, exact: true })).toBeVisible();
    await expect(railLink(page, label)).toHaveAttribute("aria-current", "page");
    await expect(rail(page).locator("[aria-current=page]")).toHaveCount(1);
    await expect(workspace(page)).toBeHidden();
  }
  await railLink(page, "작업 영역").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(workspace(page)).toBeVisible();
  await expect(railLink(page, "작업 영역")).toHaveAttribute("aria-current", "page");
});

test("맨 아래 단축키 단추는 단축키 판을 연다", async ({ page }) => {
  await page.goto("/market");
  await rail(page).getByRole("button", { name: "단축키" }).click();
  await expect(page.getByRole("dialog", { name: "단축키", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/market$/);
});

test("시장 종합에서 새로 고침해도 그 주소이고, 뒤로 가기로 작업 영역에 돌아온다", async ({ page }) => {
  await page.goto("/");
  await railLink(page, "시장 종합").click();
  await expect(page).toHaveURL(/\/market$/);
  await page.reload();
  await expect(page).toHaveURL(/\/market$/);
  await expect(page.getByRole("main", { name: "시장 종합", exact: true })).toBeVisible();
  await expect(railLink(page, "시장 종합")).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(workspace(page)).toBeVisible();
  await expect(railLink(page, "작업 영역")).toHaveAttribute("aria-current", "page");
});

test("페이지에 갔다 와도 작업 영역 차트는 다시 불러오지 않고 구독도 풀리지 않는다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.live.subscriptions().length).toBeGreaterThan(0);
  const bars = barRequests(scenario);
  const released = unsubscribes(scenario);
  const subscriptions = scenario.live.subscriptions().length;
  expect(bars).toBeGreaterThan(0);
  const first = await cell(page).boundingBox();

  await railLink(page, "히트맵").click();
  await expect(page.getByRole("main", { name: "히트맵", exact: true })).toBeVisible();
  await railLink(page, "ETF").click();
  await expect(page.getByRole("main", { name: "ETF", exact: true })).toBeVisible();
  await railLink(page, "작업 영역").click();
  await expect(cell(page)).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  expect(await cell(page).boundingBox()).toEqual(first);
  expect(barRequests(scenario)).toBe(bars);
  expect(unsubscribes(scenario)).toBe(released);
  expect(scenario.live.subscriptions()).toHaveLength(subscriptions);
});

test("다른 페이지에서 누른 키는 숨은 작업 영역에 닿지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const groups = page.locator("[data-dock-group]");
  await expect(groups).toHaveCount(2);
  const last = groups.last();
  const row = (await last.locator(".dock-tabs").boundingBox())!;
  const lastTab = (await last.locator(".dock-tab-group").last().boundingBox())!;
  const add = (await last.locator(".dock-add").boundingBox())!;
  await last.locator(".dock-tabs").dblclick({ position: { x: (lastTab.x + lastTab.width + add.x) / 2 - row.x, y: row.height / 2 } });
  await expect(groups).toHaveCount(1);
  await railLink(page, "시장 종합").click();
  await expect(page.getByRole("main", { name: "시장 종합", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^보낼 연동 색/ }).focus();
  await page.keyboard.press("Escape");
  await railLink(page, "작업 영역").click();
  await expect(workspace(page)).toBeVisible();
  await expect(groups).toHaveCount(1);
});

test("vally 로고를 누르면 랜딩으로 가고, 로그인 상태 랜딩에 작업 영역 열기와 바로가기 5개가 있다", async ({ page, scenario }) => {
  scenario.live.account = SIGNED_IN;
  await page.goto("/");
  await expect(cell(page)).toBeVisible();
  await brand(page).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(landing(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toHaveCount(0);
  const shortcuts = page.getByRole("region", { name: "페이지 바로가기" });
  await expect(shortcuts.getByRole("link")).toHaveCount(5);
  await expect(shortcuts.getByRole("link", { name: /^시장 종합/ })).toHaveAttribute("href", "/market");
  await expect(shortcuts.getByRole("link", { name: /^히트맵/ })).toHaveAttribute("href", "/heatmap");
  await expect(shortcuts.getByRole("link", { name: /^ETF/ })).toHaveAttribute("href", "/etf");
  await expect(shortcuts.getByRole("link", { name: /^호가 복기/ })).toHaveAttribute("href", "/replay");
  await expect(shortcuts.getByRole("link", { name: /^매매 복기/ })).toHaveAttribute("href", "/journal");

  await page.getByRole("link", { name: "작업 영역 열기", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(landing(page)).toHaveCount(0);
  await expect(workspace(page)).toBeVisible();
});

test("페이지의 로고도 랜딩으로 가고, 바로가기로 다른 페이지에 간다", async ({ page, scenario }) => {
  scenario.live.account = SIGNED_IN;
  await page.goto("/etf");
  await brand(page).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(landing(page)).toBeVisible();
  await page.getByRole("region", { name: "페이지 바로가기" }).getByRole("link", { name: /^히트맵/ }).click();
  await expect(page).toHaveURL(/\/heatmap$/);
  await expect(page.getByRole("main", { name: "히트맵", exact: true })).toBeVisible();
});

test("로그아웃 상태에서는 어느 주소로 와도 랜딩이 먼저 보이고 주소는 그대로다", async ({ page, scenario }) => {
  scenario.live.account = SIGNED_OUT;
  await page.goto("/etf");
  await expect(landing(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/etf$/);
  await expect(rail(page)).toHaveCount(0);
  await page.goto("/home");
  await expect(landing(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "페이지 바로가기" })).toHaveCount(0);
});

test("모르는 주소는 지금처럼 작업 영역으로 돌아간다", async ({ page }) => {
  await page.goto("/nowhere");
  await expect(page).toHaveURL(/\/$/);
  await expect(workspace(page)).toBeVisible();
});

test.describe("종목 보내기", () => {
  test.beforeEach(({ scenario }) => {
    const layout = scenario.documents.layout();
    const second = { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } as const;
    scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: [...withFirstChart(layout, { link: "a", symbol: "005930", venue: "combined" }), second] });
  });

  test("고른 연동 색의 차트에 종목이 열리고 주소가 작업 영역이 된다", async ({ page, scenario }) => {
    const ui = scenario.documents.uiState();
    scenario.documents.saveUiState({ ...ui, pageLink: "b", recentSymbols: ["028260"], revision: ui.revision + 1 });
    serveMarketRankings(scenario);
    await page.goto("/market");
    await expect(page.getByRole("button", { name: "보낼 연동 색: B" })).toBeVisible();
    await page.getByRole("button", { name: "삼성물산", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: 삼성물산/);
    await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
    await page.goBack();
    await expect(page).toHaveURL(/\/market$/);
  });

  test("연동 색 고르기는 화면 설정에 남고, 고른 색의 차트가 없으면 활성 차트에 열린다", async ({ page, scenario }) => {
    const ui = scenario.documents.uiState();
    scenario.documents.saveUiState({ ...ui, recentSymbols: ["028260"], revision: ui.revision + 1 });
    serveMarketRankings(scenario);
    await page.goto("/market");
    await page.getByRole("button", { name: /^보낼 연동 색/ }).click();
    await page.getByRole("menuitemradio", { name: /^C · 창 0개/ }).click();
    await expect(page.getByRole("button", { name: "보낼 연동 색: C" })).toBeVisible();
    await expect.poll(() => scenario.documents.uiState().pageLink).toBe("c");
    await page.getByRole("button", { name: "삼성물산", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성물산/);
    await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: SK하이닉스/);
  });
});

test.describe("390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("세로 메뉴는 없고 페이지 주소로 직접 오면 페이지가 열린다", async ({ page }) => {
    await page.goto("/market");
    await expect(page.getByRole("main", { name: "시장 종합", exact: true })).toBeVisible();
    await expect(rail(page)).toBeHidden();
    await page.getByRole("link", { name: "작업 영역으로" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cell(page)).toBeVisible();
  });
});
