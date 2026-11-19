import type { Page } from "@playwright/test";
import { ETF_DETAILS, etfDetailOf, etfHoldersOf } from "./fixtures/etf-data";
import { cell, expect, test } from "./harness";

const MEGA = etfDetailOf("444200");
const SEMI = etfDetailOf("091160");

const basketBox = (page: Page, code: string) => page.locator(`.etf-basket-box[data-basket-code="${code}"]`);
const matrix = (page: Page) => page.getByRole("table", { name: "겹침 행렬" });
const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const minBps = (a: readonly { code: string; weightBps: number }[], b: readonly { code: string; weightBps: number }[]) =>
  a.reduce((sum, x) => sum + Math.min(x.weightBps, b.find((y) => y.code === x.code)?.weightBps ?? 0), 0);

test("바구니에 3개를 담으면 3×3 행렬이 보이고 주소에 남아 새로 고침해도 같다", async ({ page }) => {
  await page.goto("/etf?tab=overlap");
  await expect(page.getByRole("tabpanel")).toContainText("2개 이상");
  for (const [index, detail] of ETF_DETAILS.entries()) {
    await basketBox(page, detail.fund.code).click();
    await expect(page.getByText(`비교 바구니 ${index + 1}/4`)).toBeVisible();
  }
  await expect(page).toHaveURL(/tab=overlap&basket=444200%2C091160%2C426030$/);
  await expect(matrix(page).locator("tbody tr")).toHaveCount(3);
  await expect(matrix(page).locator(".etf-matrix-cell")).toHaveCount(9);
  await expect(matrix(page).locator('[data-row="444200"][data-column="091160"]')).toHaveText(percent(minBps(MEGA.holdings, SEMI.holdings)));
  await expect(matrix(page).locator('[data-row="444200"][data-column="444200"]')).toHaveText("100.00%");

  await page.reload();
  await expect(matrix(page).locator(".etf-matrix-cell")).toHaveCount(9);
  await expect(basketBox(page, "091160")).toBeChecked();
  await expect(page.getByText("비교 바구니 3/4")).toBeVisible();
});

test("5번째는 담기지 않고 이유가 보인다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=a1,a2,a3,444200");
  await expect(page.getByText("비교 바구니 4/4")).toBeVisible();
  await basketBox(page, "091160").click();
  await expect(page.getByRole("alert").filter({ hasText: "4개까지" })).toBeVisible();
  await expect(basketBox(page, "091160")).not.toBeChecked();
  await expect(page).toHaveURL(/basket=a1,a2,a3,444200$/);
  await basketBox(page, "444200").click();
  await expect(page.getByRole("alert").filter({ hasText: "4개까지" })).toHaveCount(0);
});

test("행렬 칸을 누르면 나비 막대에 공통 종목이 보이고 종목을 누르면 차트로 간다", async ({ page }) => {
  await page.goto("/etf?tab=overlap&basket=444200,091160,426030");
  await matrix(page).locator('[data-row="444200"][data-column="091160"]').click();
  const butterfly = page.getByRole("region", { name: "공통 종목 나비 막대" });
  const common = MEGA.holdings.filter((h) => SEMI.holdings.some((s) => s.code === h.code));
  await expect(butterfly.locator(".etf-butterfly-row")).toHaveCount(common.length);
  for (const h of common) {
    const other = SEMI.holdings.find((s) => s.code === h.code)!;
    const row = butterfly.locator(`.etf-butterfly-row[data-code="${h.code}"]`);
    await expect(row.getByRole("img", { name: `${MEGA.fund.name} ${h.name} ${percent(h.weightBps)}` })).toBeVisible();
    await expect(row.getByRole("img", { name: `${SEMI.fund.name} ${h.name} ${percent(other.weightBps)}` })).toBeVisible();
  }
  await expect(butterfly.locator(".etf-butterfly-row", { hasText: "에코프로" })).toHaveCount(1);
  await expect(butterfly.locator(".etf-butterfly-row", { hasText: "합성종목" })).toHaveCount(0);

  await butterfly.getByRole("button", { name: "SK하이닉스 연동 차트로 보내기" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: SK하이닉스/);
});

test("역추적에서 종목을 찾으면 담은 ETF가 보이고 행을 누르면 그 ETF의 구성 탭이 열린다", async ({ page }) => {
  await page.goto("/etf?tab=reverse");
  await page.getByRole("searchbox", { name: "종목 이름·코드 검색" }).fill("삼성전자");
  await page.getByRole("list", { name: "종목 검색 결과" }).locator('[data-code="005930"]').click();
  await expect(page).toHaveURL(/stock=005930/);
  const rows = page.getByRole("table", { name: "담은 ETF 표" }).locator("tbody tr");
  const holders = etfHoldersOf("005930").holders;
  await expect(rows).toHaveCount(holders.length);
  for (const holder of holders) await expect(rows.locator(`xpath=self::tr[@data-code="${holder.fund.code}"]`)).toContainText(percent(holder.weightBps));

  await page.reload();
  await expect(rows).toHaveCount(holders.length);

  await rows.locator('xpath=self::tr[@data-code="091160"]').click();
  await expect(page).toHaveURL(/code=091160&tab=holdings/);
  await expect(page.getByRole("tab", { name: "구성" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: SEMI.fund.name, level: 2 })).toBeVisible();
});
