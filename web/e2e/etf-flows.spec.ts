import { expect, test } from "./harness";

test("자금 흐름 탭에서 기간·방향·대상을 전환하고 행 클릭으로 개별 좌수·자금 차트로 이동한다", async ({ page }) => {
  await page.goto("/etf?tab=flows");
  await expect(page.getByRole("tab", { name: "자금 흐름" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("자금 흐름 요약")).toContainText("+410억");

  const table = page.getByRole("table", { name: "자금 유출입 랭킹 표" });
  await expect(table.locator("tbody tr[data-code]")).toHaveCount(3);
  await expect(table.locator('tr[data-code="091160"]')).toContainText("+520억");
  await expect(table.locator('tr[data-code="069500"]')).toContainText("-320억");

  await page.getByRole("group", { name: "유출입 방향" }).getByRole("button", { name: "순유입 TOP" }).click();
  await expect(table.locator("tbody tr[data-code]")).toHaveCount(2);

  await page.getByRole("group", { name: "자금 흐름 대상 필터" }).getByRole("button", { name: "액티브만" }).click();
  await expect(table.locator("tbody tr[data-code]")).toHaveCount(1);
  await expect(table.locator('tr[data-code="444200"]')).toBeVisible();

  await table.locator('tr[data-code="444200"]').click();
  await expect(page).toHaveURL(/code=444200&tab=shares/);
  await expect(page.getByRole("tab", { name: "좌수·자금" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("상장좌수 요약")).toContainText("2,500만좌");
  await expect(page.getByRole("table", { name: "일별 상장좌수 원장 표" }).locator('tr[data-date="2026-11-19"]')).toContainText("분할보정");
});

test("카탈로그 밖 KRX ETF도 좌수·자금 탭에서 시계열 차트와 오버레이 토글이 동작한다", async ({ page }) => {
  await page.goto("/etf?code=069500&tab=shares");
  await expect(page.getByRole("heading", { name: "KODEX 200", level: 2 })).toBeVisible();
  await expect(page.getByRole("img", { name: "일자별 상장좌수 및 추정 순자금 유출입 차트" })).toBeVisible();

  const overlayGroup = page.getByRole("group", { name: "보조 추이선" });
  await overlayGroup.getByRole("button", { name: "순자산(AUM)" }).click();
  await expect(overlayGroup.getByRole("button", { name: "순자산(AUM)" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("table", { name: "일별 상장좌수 원장 표" }).locator("tbody tr")).toHaveCount(3);
});

test("KRX API 키가 미설정이면 자금 흐름과 좌수 탭에 설정 안내를 보이고 기존 탭은 유지한다", async ({ page, scenario }) => {
  const notConfiguredStatus = {
    state: "not_configured",
    configured: false,
    latestDate: null,
    firstDate: null,
    collectedDays: 0,
    backfillTargetDays: 60,
    lastAttemptAt: null,
    message: null,
  };
  scenario.reply("/api/etf/flows", {
    body: {
      status: notConfiguredStatus,
      window: 5,
      direction: "all",
      scope: "all",
      sort: "amount",
      fromDate: null,
      toDate: null,
      summary: {
        totalEtfCount: 0,
        totalAumWon: 0,
        totalNetFlowWon: 0,
        inflowEtfCount: 0,
        outflowEtfCount: 0,
        inflowTotalWon: 0,
        outflowTotalWon: 0,
        topInflowCode: null,
        topInflowName: null,
        topInflowWon: null,
        topOutflowCode: null,
        topOutflowName: null,
        topOutflowWon: null,
      },
      rows: [],
    },
  });

  await page.goto("/etf?tab=flows");
  const setup = page.getByRole("region", { name: "KRX Open API 설정 안내" });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText("VALLY_KRX_API_KEY");

  await page.getByRole("button", { name: "동시 매집 탭 보기" }).click();
  await expect(page.getByRole("tab", { name: "동시 매집" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("table", { name: "동시 매집 종목 표" })).toBeVisible();
});
