import { cell, DEFAULT_LAYOUT_ID, expect, firstChart, test } from "./harness";

test("바꾼 종목·거래소·봉 주기가 새로고침 뒤에도 남는다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");

  await cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: "NXT" }).click();
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
  await saved;
  await expect(page.getByRole("contentinfo").getByText(/자동 저장됨/)).toBeVisible();

  const expectRestored = async () => {
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 NXT 주");
    await expect(cell(page).getByRole("group", { name: "거래소" }).getByRole("button", { name: "NXT" })).toHaveAttribute("aria-pressed", "true");
    await expect(toolbar.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true })).toHaveAttribute("aria-pressed", "true");
  };
  await page.reload();
  await expectRestored();


  await page.reload();
  await expectRestored();
});

test("종목을 바꾸면 창 목록과 배치째 저장되고, 새로고침 뒤에도 바뀐 종목과 관심종목·스크리너·개체 목록 창이 남는다", async ({ page, scenario }) => {
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.ok());
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await saved;

  const stored = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  expect(Object.keys(stored).sort()).toEqual(["id", "name", "placement", "revision", "sync", "updatedAt", "windows"]);
  expect(stored.placement).toEqual({ v: 1, dock: null, canvas: null });
  expect(stored.windows.map((w) => [w.id, w.kind])).toEqual([["cell-0", "chart"], ["watchlist", "watchlist"], ["screener", "screener"], ["objects", "objects"]]);
  expect(firstChart(stored)).toMatchObject({ symbol: "005930", venue: "combined", period: "D" });

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.map((w) => w.kind)).toEqual(["chart", "watchlist", "screener", "objects"]);
});
