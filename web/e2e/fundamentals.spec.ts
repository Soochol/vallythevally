import { cell, chartOf, expect, test } from "./harness";

test("종목 기본 정보 블록과 조회를 제거해도 종목·지수 차트와 관심종목은 유지한다", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/fundamentals")) requests.push(r.url()); });
  for (const symbol of ["005930", "IDX:001"]) {
    await page.goto(`/?symbol=${symbol}`);
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
    await expect(page.getByRole("region", { name: "종목 정보" })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "관심종목" })).toBeVisible();
  }
  expect(requests).toEqual([]);
});
