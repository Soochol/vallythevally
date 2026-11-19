import type { Page } from "@playwright/test";
import { EARLIER_CHANGES, LATEST_CHANGES, MEGA_HISTORY, SINGLE_DAY_HISTORY } from "./fixtures/etf-data";
import { cell, expect, test } from "./harness";

const timeline = (page: Page) => page.getByRole("region", { name: "날짜 쌍 타임라인" });
const pairButton = (page: Page, after: string) => timeline(page).locator(`[data-pair="${after}"]`);
const changeTable = (page: Page) => page.getByRole("table", { name: "종목별 증감 표" });

test("타임라인에 쌍마다 편입·편출·늘림·줄임 개수가 보이고 가장 최근 쌍의 증감 표가 먼저 열린다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history");
  await expect(timeline(page).locator("li")).toHaveCount(MEGA_HISTORY.pairs.length);
  const latest = pairButton(page, "2026-11-18");
  await expect(latest).toHaveAttribute("aria-pressed", "true");
  await expect(latest).toContainText("편입 1");
  await expect(latest).toContainText("편출 1");
  await expect(latest).toContainText("늘림 1");
  await expect(latest).toContainText("줄임 1");
  await expect(page.getByRole("region", { name: "종목별 증감" })).toContainText("공통 배율 ×0.940");
  await expect(changeTable(page).locator("tbody tr")).toHaveCount(LATEST_CHANGES.rows.length);
  const hynix = changeTable(page).locator('tr[data-code="000660"]');
  await expect(hynix).toContainText("1,000");
  await expect(hynix).toContainText("1,200");
  await expect(hynix).toContainText("+27.7%");
  await expect(hynix).toContainText("늘림");
  await expect(changeTable(page).locator('tr[data-code="005930"]')).toContainText("-20.2%");
  await expect(changeTable(page).locator('tr[data-code="402340"]')).toContainText("편입");
  await expect(changeTable(page).locator('tr[data-code="086520"]')).toContainText("편출");
  await expect(changeTable(page).locator('tr[data-code="035420"]')).toContainText("유지");
});

test("타임라인의 쌍을 고르면 증감 표가 그 쌍으로 바뀌고 주소에 남는다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history");
  await expect(changeTable(page).locator('tr[data-code="000660"]')).toHaveCount(1);

  await pairButton(page, "2026-11-14").click();
  await expect(pairButton(page, "2026-11-14")).toHaveAttribute("aria-pressed", "true");
  await expect(pairButton(page, "2026-11-18")).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/pair=2026-11-14$/);
  await expect(page.getByRole("region", { name: "종목별 증감" })).toContainText("공통 배율 ×1.000");
  await expect(changeTable(page).locator("tbody tr")).toHaveCount(EARLIER_CHANGES.rows.length);
  await expect(changeTable(page).locator('tr[data-code="051910"]')).toContainText("+10.0%");
  await expect(changeTable(page).locator('tr[data-code="000660"]')).toHaveCount(0);

  await page.reload();
  await expect(pairButton(page, "2026-11-14")).toHaveAttribute("aria-pressed", "true");
  await expect(changeTable(page).locator("tbody tr")).toHaveCount(EARLIER_CHANGES.rows.length);
});

test("증감 표의 종목을 누르면 연동 색 차트에 그 종목이 열린다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history");
  await changeTable(page).locator('tr[data-code="000660"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("수집일이 하나뿐인 응답이면 안내와 첫 수집일이 보이고 타임라인은 없다", async ({ page }) => {
  await page.goto("/etf?code=091160&tab=history");
  const notice = page.getByRole("status").filter({ hasText: "수집을 시작한 날부터 쌓입니다" });
  await expect(notice).toContainText(`첫 수집일 ${SINGLE_DAY_HISTORY.firstCollectedOn}`);
  await expect(timeline(page)).toHaveCount(0);
  await expect(changeTable(page)).toHaveCount(0);
});

test("수집한 날짜가 없으면 아직 수집한 날짜가 없다고 알린다", async ({ page }) => {
  await page.goto("/etf?code=426030&tab=history");
  const notice = page.getByRole("status").filter({ hasText: "수집을 시작한 날부터 쌓입니다" });
  await expect(notice).toContainText("아직 수집한 날짜가 없습니다");
});

test("다른 ETF를 고르면 고른 쌍은 지워지고 그 ETF의 이력이 보인다", async ({ page }) => {
  await page.goto("/etf?code=444200&tab=history&pair=2026-11-14");
  await page.getByRole("list", { name: "ETF" }).locator('[data-code="091160"]').click();
  await expect(page).not.toHaveURL(/pair=/);
  await expect(page.getByRole("status").filter({ hasText: "수집을 시작한 날부터 쌓입니다" })).toContainText("첫 수집일 2026-11-18");
});

test("증감을 불러오지 못하면 다시 시도로 불러온다", async ({ page, scenario }) => {
  let failing = true;
  scenario.on("/api/etf/funds/444200/changes", () => (failing ? { status: 503, body: { error: { code: "internal", message: "실패", reason: null, retryAt: null, manualActionRequired: false } } } : { body: LATEST_CHANGES }));
  await page.goto("/etf?code=444200&tab=history");
  await expect(page.getByRole("alert")).toContainText("증감을 불러오지 못했습니다");
  failing = false;
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(changeTable(page).locator("tbody tr")).toHaveCount(LATEST_CHANGES.rows.length);
});
