import type { Page } from "@playwright/test";
import { ETF_DETAILS, ETF_FUNDS, etfDetailOf, withEtfMa } from "./fixtures/etf-data";
import { cell, expect, test } from "./harness";

const MEGA = etfDetailOf("444200");
const FAILED = etfDetailOf("426030");

const list = (page: Page) => page.getByRole("list", { name: "ETF" });
const fundButton = (page: Page, code: string) => list(page).locator(`[data-code="${code}"]`);
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

test("목록 검색과 액티브 필터가 행을 줄인다", async ({ page }) => {
  await page.goto("/etf");
  await expect(list(page).getByRole("button")).toHaveCount(ETF_FUNDS.funds.length);

  await page.getByRole("searchbox", { name: "ETF 이름·코드 검색" }).fill("반도체");
  await expect(list(page).getByRole("button")).toHaveCount(1);
  await expect(fundButton(page, "091160")).toBeVisible();

  await page.getByRole("searchbox", { name: "ETF 이름·코드 검색" }).fill("");
  await page.getByRole("group", { name: "운용 방식" }).getByRole("button", { name: "액티브" }).click();
  await expect(list(page).getByRole("button")).toHaveCount(2);
  await expect(fundButton(page, "091160")).toHaveCount(0);

  await page.getByRole("combobox", { name: "운용사" }).selectOption("신한자산운용");
  await expect(list(page).getByRole("button")).toHaveCount(1);
  await expect(fundButton(page, "444200")).toBeVisible();
});

test("ETF를 고르면 주소가 /etf?code=...가 되고 새로 고침해도 같은 ETF가 열린다", async ({ page }) => {
  await page.goto("/etf");
  await fundButton(page, "444200").click();
  await expect(page).toHaveURL(/\/etf\?code=444200&tab=holdings$/);
  await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/code=444200/);
  await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();
  await expect(fundButton(page, "444200")).toHaveAttribute("aria-pressed", "true");
});

test("요약 4칸과 트리맵·표가 응답 값과 맞다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=holdings");
  const summary = page.getByLabel("요약 지표");
  await expect(summary).toContainText("종목 수");
  await expect(summary.locator(".etf-summary-cell").nth(0).locator("dd")).toHaveText(`${MEGA.fund.holdingsCount}개`);
  await expect(summary.locator(".etf-summary-cell").nth(1).locator("dd")).toHaveText(percent(MEGA.fund.top5WeightBps));
  await expect(summary.locator(".etf-summary-cell").nth(2).locator("dd")).toHaveText(MEGA.fund.effectiveHoldings.toFixed(1));
  await expect(summary.locator(".etf-summary-cell").nth(3).locator("dd")).toHaveText(MEGA.fund.status.holdingsAsOf);

  const treemap = page.getByRole("group", { name: "구성 종목 트리맵" });
  await expect(treemap.getByRole("button")).toHaveCount(MEGA.holdings.length);
  for (const h of MEGA.holdings) await expect(treemap.locator(`[data-code="${h.code}"]`)).toHaveAttribute("aria-label", `${h.name} ${percent(h.weightBps)}`);

  const rows = page.getByRole("table", { name: "구성 종목 표" }).locator("tbody tr");
  await expect(rows).toHaveCount(MEGA.holdings.length);
  for (const [i, h] of MEGA.holdings.entries()) {
    await expect(rows.nth(i)).toContainText(h.name);
    await expect(rows.nth(i)).toContainText(percent(h.weightBps));
  }

  const curve = page.getByRole("img", { name: /^누적 비중 곡선/ });
  const top5 = MEGA.fund.top5WeightBps;
  await expect(curve.locator('[data-rank="5"]')).toHaveAttribute("data-cumulative-bps", String(top5));
});

test("트리맵 칸을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page }) => {
  await page.goto("/etf?code=444200");
  await page.getByRole("group", { name: "구성 종목 트리맵" }).locator('[data-code="000660"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("표 행을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page }) => {
  await page.goto("/etf?code=091160");
  await page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="005930"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
});

test("출처가 갱신 실패면 '갱신 실패'와 마지막 성공 기준일이 보인다", async ({ page }) => {
  await page.goto("/etf?code=444200");
  const freshness = page.getByRole("status", { name: "자료 신선도" });
  await expect(freshness).toHaveText(`자료 출처 스냅샷 · 기준일 ${MEGA.fund.status.holdingsAsOf}`);

  await fundButton(page, "426030").click();
  await expect(freshness).toContainText("갱신 실패");
  await expect(freshness).toContainText(`마지막 성공 기준일 ${FAILED.fund.status.holdingsAsOf}`);
});

test("이평선 칸이 있으면 점 3개가 상태대로 보이고, null이면 빈 자리다", async ({ page, scenario }) => {
  await page.goto("/etf?code=444200");
  const samsung = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="005930"]');
  await expect(samsung.getByRole("img")).toHaveCount(3);
  await expect(samsung.getByRole("img", { name: "20일선 상회" })).toHaveAttribute("data-state", "above");
  await expect(samsung.getByRole("img", { name: "60일선 하회" })).toHaveAttribute("data-state", "below");
  await expect(samsung.getByRole("img", { name: "120일선 일치" })).toHaveAttribute("data-state", "equal");

  const row = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="051910"]');
  await expect(row.getByRole("img")).toHaveCount(0);
  await expect(row.locator(".etf-ma-slot")).toHaveCount(3);

  scenario.reply("/api/etf/funds/091160", { body: withEtfMa("091160", { ma20: "below", ma60: null, ma120: "above" }) });
  await page.goto("/etf?code=091160");
  const semi = page.getByRole("table", { name: "구성 종목 표" }).locator('tr[data-code="000660"]');
  await expect(semi.getByRole("img")).toHaveCount(2);
  await expect(semi.locator(".etf-ma-slot")).toHaveCount(3);
});

test("없는 코드로 오면 목록과 '찾을 수 없음' 안내가 보인다", async ({ page }) => {
  await page.goto("/etf?code=999999");
  await expect(page.getByText("찾을 수 없음", { exact: true })).toBeVisible();
  await expect(list(page).getByRole("button")).toHaveCount(ETF_DETAILS.length);
  await fundButton(page, "091160").click();
  await expect(page).toHaveURL(/code=091160/);
  await expect(page.getByText("찾을 수 없음", { exact: true })).toHaveCount(0);
});

test("편입 변경 탭은 주소에 남고 구성 탭으로 돌아올 수 있다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history");
  await expect(page.getByRole("tab", { name: "편입 변경" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "구성" }).click();
  await expect(page).toHaveURL(/tab=holdings/);
  await expect(page.getByRole("group", { name: "구성 종목 트리맵" })).toBeVisible();
});
