import { expect, test, type Scenario } from "./harness";

function seedJournalExecutions(scenario: Scenario) {
  scenario.on("/api/trading/executions", () => ({
    status: 200,
    body: {
      day: "2026-11-27",
      accountRef: "acc-1",
      executions: [
        { orderNo: "B1", code: "005930", name: "삼성전자", side: "buy", quantity: 20, price: 70_000, time: "09:05:00", venue: "krx" },
        { orderNo: "S1", code: "005930", name: "삼성전자", side: "sell", quantity: 20, price: 72_000, time: "09:22:00", venue: "krx" },
        { orderNo: "B2", code: "000660", name: "SK하이닉스", side: "buy", quantity: 10, price: 200_000, time: "11:45:00", venue: "krx" },
        { orderNo: "B3", code: "000660", name: "SK하이닉스", side: "buy", quantity: 10, price: 198_000, time: "12:02:00", venue: "krx" },
        { orderNo: "S2", code: "000660", name: "SK하이닉스", side: "sell", quantity: 20, price: 195_000, time: "12:35:00", venue: "krx" },
      ],
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
}

test("/journal에서 타점 복기 스튜디오와 어디서 벌고 잃었나가 즉시 필터 연동된다", async ({ page, scenario }) => {
  seedJournalExecutions(scenario);
  await page.goto("/journal");

  await expect(page.getByTestId("journal-page")).toBeVisible();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 2건");
  await expect(page.getByTestId("journal-candle-chart")).toBeVisible();
  await expect(page.getByTestId("journal-where-section")).toBeVisible();

  await page.getByTestId("journal-pair-open_open").click();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-token-pair")).toBeVisible();
  await expect(page.getByTestId("journal-where-jump-top")).toContainText("1건");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 2건");

  await page.getByTestId("journal-memo-input").fill("시초 거래대금 돌파 확인");
  await expect(page.getByTestId("journal-memo-input")).toHaveValue("시초 거래대금 돌파 확인");

  await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일봉", exact: true }).click();
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-tf", "D");
});

test("/journal과 /journal/analytics 2페이지가 분리되어 오가며 날짜·행 클릭 시 복기로 점프한다", async ({ page, scenario }) => {
  seedJournalExecutions(scenario);
  await page.goto("/journal");

  await page.getByTestId("journal-go-analytics").click();
  await expect(page).toHaveURL(/\/journal\/analytics$/);
  await expect(page.getByTestId("journal-analytics-view")).toBeVisible();
  await expect(page.getByTestId("journal-where-section")).toHaveCount(0);

  const afterCostText = await page.getByTestId("analytics-net-pnl").innerText();
  await page.getByTestId("analytics-cost-switch").click();
  await expect(page.getByTestId("analytics-net-pnl")).not.toHaveText(afterCostText);
  await page.getByTestId("analytics-cost-switch").click();

  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "달력", exact: true }).click();
  await page.getByTestId("analytics-cal-day-2026-11-27").click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByTestId("journal-period-label")).toContainText("2026.11.27");

  await page.getByTestId("journal-go-analytics").click();
  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "월", exact: true }).click();
  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "표", exact: true }).click();
  await page.getByRole("group", { name: "표 묶음 단위" }).getByRole("button", { name: "종목별", exact: true }).click();
  await page.getByTestId("analytics-table-row-005930").click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-detail-name")).toHaveText("삼성전자");
});
