import type { Page } from "@playwright/test";
import type { Quote } from "../src/api/generated/Quote";
import { type Scenario, cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });
const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const quote = (price = 50_000, change = -1000, changeRate = -1.96): Quote => ({ symbol: "005930", price, change, changeRate, volume: 1_300_000, t: 1794186000, source: "realtime" });

function putWatchlist(scenario: Scenario, symbols: string[]) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => i === 0 ? { ...list, symbols } : list), revision: current.revision + 1 });
  scenario.reply("/api/quotes", { body: [quote()] });
}
function countQuoteRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/quotes")) urls.push(request.url()); });
  return urls;
}

test("실시간 시세와 봉 응답은 관심종목 줄과 차트를 바꾸고 REST를 반복하지 않는다", async ({ page, scenario }) => {
  putWatchlist(scenario, ["005930"]);
  const requests = countQuoteRequests(page);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  const button = row(page, "005930").locator("[data-main]");
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
  await expect.poll(() => scenario.live.subscriptions().some(value => value.symbol === "005930")).toBe(true);
  scenario.live.emit({ type: "quotes", quotes: [quote(51_500, 500, 0.98)] });
  scenario.live.update("005930", { c: 51_500 });
  await expect(chart).toHaveAttribute("data-last-close", "51500");
  await expect(button).toHaveAccessibleName("삼성전자 51,500 +0.98%");
  scenario.live.emit({ type: "quotes", quotes: [quote(49_800, -1200, -2.35)] });
  scenario.live.update("005930", { c: 49_800 });
  await expect(chart).toHaveAttribute("data-last-close", "49800");
  await expect(button).toHaveAccessibleName("삼성전자 49,800 −2.35%");
  expect(requests).toHaveLength(1);
});

test("제한된 관심종목은 실시간 아님을 표시하고 제한 해제 뒤 추가 조회 없이 회복한다", async ({ page, scenario }) => {
  const synthetic = Array.from({ length: 199 }, (_, i) => String(950_000 + i * 10));
  putWatchlist(scenario, [...synthetic, "005930"]);
  for (const code of synthetic) scenario.reply(`/api/symbols/${code}`, { body: { code, name: `합성${code}`, kind: "common", market: "kospi", nxtEnabled: false } });
  const requests = countQuoteRequests(page);
  await page.goto("/");
  await expect(panel(page).locator("li[data-code]")).toHaveCount(200);
  const button = row(page, "005930").locator("[data-main]");
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
  scenario.live.emit({ type: "watch_limited", symbols: ["005930"] });
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96% 실시간 아님");
  await expect(row(page, "005930")).toContainText("실시간 아님");
  await row(page, synthetic[0]!).click({ button: "right" });
  await page.getByRole("menuitem", { name: "관심종목에서 빼기" }).click();
  scenario.live.emit({ type: "watch_limited", symbols: [] });
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
  await expect(row(page, "005930")).not.toContainText("실시간 아님");
  expect(requests).toHaveLength(1);
});
