import { expect, test } from "./harness";

test("신규 창 3종(스캐너·테마·미니그리드)을 창 더하기에서 열고 미니그리드 열·종목을 편집한다", async ({ page, scenario }) => {
  scenario.on("/api/rankings", () => ({
    status: 200,
    body: {
      source: "kiwoom",
      fetchedAt: 1_764_200_000,
      rows: [],
      hidden: 0,
      end: true,
      limited: false,
    },
  }));
  scenario.on("/api/kiwoom-themes", () => ({
    status: 200,
    body: {
      periodDays: 1,
      fetchedAt: 1_764_200_000,
      themes: [],
      pages: 1,
      complete: true,
      skipped: 0,
    },
  }));
  for (const code of ["005930", "000660", "035420", "035720", "042700"]) {
    scenario.on(`/api/symbols/${code}/order-book`, () => ({
      status: 200,
      body: {
        symbol: code,
        venue: "krx",
        t: 1_764_200_000,
        asks: [],
        bids: [],
        totalAsk: 0,
        totalBid: 0,
        expected: null,
        afterHours: null,
      },
    }));
  }
  await page.goto("/");
  await page.getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menuitem", { name: "실시간 스캐너" }).click();
  await expect(page.getByTestId("scanner-window")).toBeVisible();

  await page.getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menuitem", { name: "테마 리더보드" }).click();
  await expect(page.getByTestId("themes-window")).toBeVisible();

  await page.getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menuitem", { name: "호가 미니 그리드" }).click();
  await expect(page.getByTestId("tape-matrix-window")).toBeVisible();

  await page.getByRole("button", { name: "3열", exact: true }).click();
  await expect(page.getByTestId("tape-matrix-grid")).toHaveAttribute("data-cols", "3");

  await page.getByLabel("종목코드 추가").fill("042700");
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await expect(page.getByTestId("tape-card-042700")).toBeVisible();
});

test("매매 복기 전용 페이지(/journal)가 네비게이션과 직접 경로로 열린다", async ({ page, scenario }) => {
  scenario.on("/api/trading/executions", () => ({
    status: 200,
    body: {
      day: "2026-11-27",
      accountRef: "acc-1",
      executions: [],
    },
  }));
  scenario.on("/api/trading/executions/forensics", () => ({
    status: 200,
    body: {
      date: "2026-11-27",
      account: "acc-1",
      items: [],
    },
  }));
  await page.goto("/journal");
  await expect(page.getByRole("main", { name: "매매 복기", exact: true })).toBeVisible();
  await expect(page.getByTestId("journal-page")).toBeVisible();
});
