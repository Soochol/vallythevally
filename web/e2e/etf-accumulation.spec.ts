import type { Page } from "@playwright/test";
import { ACCUMULATION_20_ACTIVE, ACCUMULATION_5_ACTIVE, ACCUMULATION_5_ALL, etfDetailOf } from "./fixtures/etf-data";
import { cell, expect, test } from "./harness";

const MEGA = etfDetailOf("444200");
const table = (page: Page) => page.getByRole("table", { name: "동시 매집 종목 표" });
const rankedRows = (page: Page) => table(page).locator("tbody tr[data-code]");

test("동시 매집 탭이 독립으로 열리고 5일 액티브 순위와 기간 배너를 보인다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  await expect(page.getByRole("tab", { name: "동시 매집" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".etf-acc-period")).toHaveText("2026-11-11 ~ 2026-11-18 · 수집일 6일");
  await expect(rankedRows(page)).toHaveCount(ACCUMULATION_5_ACTIVE.rows.length);

  const hynix = table(page).locator('tr[data-code="000660"]');
  await expect(hynix).toContainText("SK하이닉스");
  await expect(hynix).toContainText("2개");
  await expect(hynix).toContainText("신규 1");
  await expect(hynix).toContainText("+27.7%");
  await expect(hynix.getByRole("img", { name: "20일선 상회", exact: true })).toHaveAttribute("data-state", "above");
  await expect(hynix.getByRole("img", { name: "60일선 상회", exact: true })).toHaveAttribute("data-state", "above");
  await expect(hynix.getByRole("img", { name: "120일선 상회", exact: true })).toHaveAttribute("data-state", "above");

  const square = table(page).locator('tr[data-code="402340"]');
  await expect(square).toContainText("SK스퀘어");
  await expect(square).toContainText("1개");
  await expect(square).toContainText("-");
});

test("대상 ETF(액티브만·전체)와 기간(5일·20일) 토글이 순위를 바꾼다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  await expect(rankedRows(page)).toHaveCount(ACCUMULATION_5_ACTIVE.rows.length);

  await page.getByRole("group", { name: "대상 ETF" }).getByRole("button", { name: "전체" }).click();
  await expect(rankedRows(page)).toHaveCount(ACCUMULATION_5_ALL.rows.length);
  await expect(table(page).locator('tr[data-code="000660"]')).toContainText("3개");
  await expect(table(page).locator('tr[data-code="005930"]')).toContainText("삼성전자");

  await page.getByRole("group", { name: "대상 ETF" }).getByRole("button", { name: "액티브만" }).click();
  await page.getByRole("group", { name: "집계 기간" }).getByRole("button", { name: "20일" }).click();
  await expect(page.locator(".etf-acc-period")).toHaveText("2026-10-21 ~ 2026-11-18 · 수집일 21일");
  await expect(rankedRows(page)).toHaveCount(ACCUMULATION_20_ACTIVE.rows.length);
  await expect(rankedRows(page).first()).toHaveAttribute("data-code", "035420");
  await expect(table(page).locator('tr[data-code="035420"]')).toContainText("+31.5%");
});

test("종목 행을 누르면 매집 ETF 드릴다운이 펼쳐지고 ETF를 누르면 그 ETF 상세로 이동한다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  const hynix = table(page).locator('tr[data-code="000660"]');
  await hynix.click();
  await expect(hynix).toHaveAttribute("aria-expanded", "true");

  const detail = page.getByRole("region", { name: "SK하이닉스 매집 ETF 목록" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".etf-acc-contrib-item")).toHaveCount(2);
  await expect(detail.locator('[data-fund-code="426030"]')).toBeVisible();
  await expect(detail.locator('[data-fund-code="444200"]')).toBeVisible();

  await detail.locator('[data-fund-code="444200"]').click();
  await expect(page).toHaveURL(/code=444200&tab=holdings/);
  await expect(page.getByRole("heading", { name: MEGA.fund.name, level: 2 })).toBeVisible();
});

test("종목의 차트 버튼을 누르면 연동 색 차트로 종목을 보낸다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  await table(page).getByRole("button", { name: "SK하이닉스 연동 차트로 보내기" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("수집일이 2일 미만이면 빈 안내를 보이고 오류 시 다시 시도로 복구한다", async ({ page, scenario }) => {
  scenario.reply("/api/etf/accumulation", {
    body: { window: 5, style: "active", direction: "buy", fromDate: null, toDate: null, collectedDays: 1, maAsOf: null, rows: [] },
  });
  await page.goto("/etf?tab=accumulation");
  const notice = page.getByRole("status").filter({ hasText: "수집일이 2일 이상 쌓이면 집계됩니다" });
  await expect(notice).toContainText("현재 수집일 1일");
  await expect(table(page)).toHaveCount(0);

  let failing = true;
  scenario.on("/api/etf/accumulation", () =>
    failing
      ? { status: 503, body: { error: { code: "internal", message: "실패", reason: null, retryAt: null, manualActionRequired: false } } }
      : { body: ACCUMULATION_5_ACTIVE },
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("동시 매집을 불러오지 못했습니다");
  failing = false;
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(rankedRows(page)).toHaveCount(ACCUMULATION_5_ACTIVE.rows.length);
});

test("동시 매집 요약·필터 칩·버블 레이더 클릭과 역추적 이동이 동작한다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  const kpis = page.getByLabel("동시 매집 요약");
  await expect(kpis).toContainText("2종목");
  await expect(kpis).toContainText("SK하이닉스");

  await page.getByRole("group", { name: "동시 매집 필터" }).getByRole("button", { name: "이평선 정배열 3▲" }).click();
  await expect(rankedRows(page)).toHaveCount(1);
  await expect(rankedRows(page).first()).toHaveAttribute("data-code", "000660");

  const radar = page.getByRole("region", { name: "컨빅션 버블 레이더" });
  await radar.locator('[data-bubble-code="000660"]').click();
  await expect(page.getByRole("region", { name: "SK하이닉스 매집 ETF 목록" })).toBeVisible();

  await table(page).getByRole("button", { name: "SK하이닉스 역추적" }).click();
  await expect(page).toHaveURL(/tab=reverse&stock=000660/);
  await expect(page.getByRole("table", { name: "담은 ETF 표" })).toBeVisible();
});

test("동시 매도 토글은 매도 레이더와 편출·줄임 드릴다운 및 역배열 필터를 보인다", async ({ page }) => {
  await page.goto("/etf?tab=accumulation");
  await page.getByRole("group", { name: "매집 방향" }).getByRole("button", { name: "동시 매도" }).click();

  const kpis = page.getByLabel("동시 매도 요약");
  await expect(kpis).toContainText("동시 매도 종목");
  await expect(kpis).toContainText("전량 편출 발생");
  await expect(kpis).toContainText("에코프로");

  const sellTable = page.getByRole("table", { name: "동시 매도 종목 표" });
  const sellRows = sellTable.locator("tbody tr[data-code]");
  await expect(sellRows).toHaveCount(2);

  const ecopro = sellTable.locator('tr[data-code="086520"]');
  await expect(ecopro).toContainText("2개");
  await expect(ecopro).toContainText("편출 1");
  await expect(ecopro).toContainText("-24.5%");

  await ecopro.click();
  const detail = page.getByRole("region", { name: "에코프로 매도 ETF 목록" });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("편출");
  await expect(detail).toContainText("이전 3.80%");
  await expect(detail).toContainText("줄임");
  await expect(detail).toContainText("-24.5%");

  await page.getByRole("group", { name: "동시 매집 필터" }).getByRole("button", { name: "이평선 역배열 0▲" }).click();
  await expect(sellRows).toHaveCount(1);
  await expect(sellRows.first()).toHaveAttribute("data-code", "086520");
});
