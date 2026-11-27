import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { cell, expect, test } from "./harness";
import { CODE, openOrderWindow, ordersOn, SETTINGS, tradingApi } from "./order-window";

function intradayArrangement(windows: LayoutWindow[]): LayoutWindow[] {
  return windows.map((window) => {
    if (window.kind === "chart") return { ...window, link: "a", period: "1m", chartSettings: SETTINGS };
    if (window.kind === "order") return { ...window, link: "a" };
    return window;
  });
}

test("호가주문창의 내 체결 탭은 포렌식 조회나 진단 뱃지 없이 체결 내역만 표시한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.executions = [
    { orderNo: "0004001", code: CODE, name: "삼성전자", side: "buy", quantity: 10, price: 70_000, time: "090500", venue: "krx" },
  ];

  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, intradayArrangement);
  await page.getByTestId("account-tab-fills").click();
  const fill = page.getByTestId("account-fill").first();
  await expect(fill).toBeVisible();
  await expect(fill).toContainText("삼성전자");
  await expect(page.getByTestId("fill-diagnosis-badge")).toHaveCount(0);
  await expect(page.getByTestId("execution-forensic-card")).toHaveCount(0);
  await fill.click();
  await expect(cell(page).locator("[data-synced-crosshair]")).toBeHidden();
  expect(scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/executions/forensics")).toHaveLength(0);
});
