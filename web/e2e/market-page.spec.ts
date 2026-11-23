import type { Page } from "@playwright/test";
import { anyMarketOverviewCall, indexCardWithoutBreadth, marketOverviewCalls, SECTOR_NAMES, serveMarketRankings } from "./fixtures/market-data";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { cell, expect, test } from "./harness";

const main = (page: Page) => page.getByRole("main", { name: "시장 종합", exact: true });
const card = (page: Page, name: string) => main(page).getByRole("region", { name });
const ROUTES = ["index", "sectors", "flow", "flow/intraday", "turnover", "streaks"] as const;

test("시장을 코스닥으로 바꾸면 모든 칸이 코스닥 요청으로 다시 받고 주소에 남는다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  for (const route of ROUTES) expect(marketOverviewCalls(scenario, route, "kosdaq")).toBe(0);

  await main(page).getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" }).click();
  await expect(page).toHaveURL(/market=kosdaq/);
  await expect(card(page, "지수·폭").getByText("코스닥", { exact: true })).toBeVisible();
  await expect(card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${SECTOR_NAMES.kosdaq[0]}`) })).toBeVisible();
  for (const route of ROUTES) await expect.poll(() => marketOverviewCalls(scenario, route, "kosdaq")).toBeGreaterThan(0);
  await expect(card(page, "종목").getByRole("button", { name: "에코프로" })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/market=kosdaq/);
  await expect(main(page).getByRole("group", { name: "시장" }).getByRole("button", { name: "코스닥" })).toHaveAttribute("aria-pressed", "true");
});

test("지수 종목 수가 없으면 '-'로 보이고 막대는 그리지 않는다", async ({ page, scenario }) => {
  scenario.reply((url) => url.pathname === "/api/market-overview/index", { body: indexCardWithoutBreadth("kospi") });
  await page.goto("/market");
  const index = card(page, "지수·폭");
  await expect(index.getByText("코스피", { exact: true })).toBeVisible();
  await expect(index.getByText("상승 -")).toBeVisible();
  await expect(index.getByText("보합 -")).toBeVisible();
  await expect(index.getByText("하락 -")).toBeVisible();
  await expect(index.locator('[data-cell="limit"] dd')).toHaveText("- / -");
  await expect(index.locator(".mk-breadth-bar")).toHaveCount(0);
});

test("기간을 바꾸면 기간 인자가 달린 칸만 그 기간으로 다시 받는다", async ({ page, scenario }) => {
  await page.goto("/market");
  await main(page).getByRole("group", { name: "기간" }).getByRole("button", { name: "60일" }).click();
  await expect(page).toHaveURL(/period=60/);
  await expect.poll(() => scenario.requests.some((r) => /flow\?market=kospi&period=60/.test(r.url()))).toBe(true);
  await expect.poll(() => scenario.requests.some((r) => /turnover\?market=kospi&period=60/.test(r.url()))).toBe(true);
});

test("누가 사고 파나 칸에 네 주체의 막대와 누적선이 있다", async ({ page }) => {
  await page.goto("/market");
  const flow = card(page, "누가 사고 파나");
  const bars = flow.getByRole("list", { name: "주체별 순매수 막대" });
  for (const subject of ["individual", "foreign", "institution", "program"]) {
    await expect(bars.locator(`[data-subject="${subject}"]`)).toBeVisible();
    await expect(flow.locator(`.mk-line[data-subject="${subject}"]`)).toHaveAttribute("d", /^M/);
  }
  await expect(bars.locator('[data-subject="individual"]')).toHaveAttribute("data-eok", "0");
  await expect(bars.locator('[data-subject="foreign"]')).toHaveAttribute("data-eok", "400");
  await expect(bars.locator('[data-subject="program"]')).toHaveAttribute("data-eok", "130");
  await expect(flow.getByRole("img", { name: "장중 누적선" })).toBeVisible();
});

test("업종 칸을 누르면 그 업종의 주체별 수급이 보인다", async ({ page }) => {
  await page.goto("/market");
  const [sector] = SECTOR_NAMES.kospi;
  await card(page, "업종 지도").getByRole("button", { name: new RegExp(`^${sector}`) }).click();
  const detail = card(page, "업종 지도").getByRole("region", { name: `${sector} 주체별 수급` });
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-subject="foreignEok"]')).toContainText("+1,500억");
  await expect(detail.locator('[data-subject="individualEok"]')).toContainText("−700억");
});

test("종목 탭 행을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  await page.goto("/market");
  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "상승" }).click();
  await stocks.getByRole("button", { name: "SK하이닉스" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("연속 탭은 순매수·순매도 연속 종목을 보이고 행을 누르면 차트로 보낸다", async ({ page }) => {
  await page.goto("/market");
  const stocks = card(page, "종목");
  await stocks.getByRole("tab", { name: "외국인 연속" }).click();
  await expect(stocks.getByRole("region", { name: "순매수 연속" })).toContainText("삼성물산");
  await expect(stocks.getByRole("region", { name: "순매도 연속" })).toContainText("LG화학");
  await stocks.getByRole("tab", { name: "기관 연속" }).click();
  await expect(stocks.getByRole("region", { name: "순매수 연속" })).toContainText("SK하이닉스");
});

test("한 경로가 오류로 답하면 그 칸만 오류이고 나머지 칸은 보인다", async ({ page, scenario }) => {
  serveMarketRankings(scenario);
  scenario.on((url) => url.pathname === "/api/market-overview/turnover", () => ({ status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
  await page.goto("/market");
  await expect(card(page, "거래대금 추이").getByRole("alert")).toContainText("키움이 응답하지 않습니다");
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
  await expect(card(page, "누가 사고 파나").locator('[data-subject="foreign"]').first()).toBeVisible();
  await expect(card(page, "업종 지도").getByRole("button").first()).toBeVisible();
  await expect(card(page, "종목").getByRole("button", { name: "삼성전자" })).toBeVisible();
  await expect(main(page).getByRole("alert")).toHaveCount(1);
});

test("키움 연결 전이면 요청 없이 연결 안내를 보이고 연결되면 칸을 받는다", async ({ page, scenario }) => {
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, state: "disconnected", message: "키움에 연결하지 않았습니다" };
  await page.goto("/market");
  await expect(main(page).getByText("키움 연결 전입니다")).toBeVisible();
  await expect(card(page, "지수·폭")).toHaveCount(0);
  expect(anyMarketOverviewCall(scenario)).toBe(false);
  scenario.live.link(CONNECTED_KIWOOM);
  await expect(card(page, "지수·폭").getByText("코스피", { exact: true })).toBeVisible();
});
