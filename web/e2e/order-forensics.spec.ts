import type { ExecutionForensics } from "../src/api/generated/ExecutionForensics";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { cell, expect, test } from "./harness";
import { ACCOUNT, CODE, openOrderWindow, ordersOn, SETTINGS, tradingApi } from "./order-window";

function intradayArrangement(windows: LayoutWindow[]): LayoutWindow[] {
  return windows.map((window) => {
    if (window.kind === "chart") return { ...window, link: "a", period: "1m", chartSettings: SETTINGS };
    if (window.kind === "order") return { ...window, link: "a" };
    return window;
  });
}

test("초기 130봉 범위 밖의 과거 체결을 누르면 차트가 해당 시점으로 스크롤해 십자선을 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  const bars = scenario.market.page({ symbol: CODE, period: "1m", venue: "combined" }).bars;
  const oldBar = bars[20]!;
  api.executions = [
    { orderNo: "0004001", code: CODE, name: "삼성전자", side: "buy", quantity: 10, price: 70_000, time: "090500", venue: "krx" },
  ];
  scenario.on(
    (url) => url.pathname === "/api/trading/executions/forensics",
    () => ({
      body: {
        date: "20261109",
        account: ACCOUNT,
        items: [
          {
            orderNo: "0004001",
            code: CODE,
            name: "삼성전자",
            side: "buy",
            time: "090500",
            fillAt: oldBar.t,
            price: 70_000,
            quantity: 10,
            collected: true,
            diagnosis: "iceberg_support",
            mfePct: 1.0,
            maePct: 0.0,
            slippageTicks: 0,
            preEntryCancelRatePct: 0,
            programDeltaMillionWon: 50,
            whaleNetDeltaMillionWon: 0,
            summary: "진입 직전 아이스버그 지지 포착 · 5분 MFE +1.00%",
          },
        ],
      } satisfies ExecutionForensics,
    }),
  );

  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, intradayArrangement);
  await page.getByTestId("account-tab-fills").click();
  await page.getByTestId("account-fill").first().click();

  const syncedCrosshair = cell(page).locator("[data-synced-crosshair]");
  await expect(syncedCrosshair).toBeVisible();
  await expect(syncedCrosshair).toHaveAttribute("data-synced-time", String(oldBar.t));
});

test("링크된 주문창의 체결 점프는 같은 링크 차트만 이동시키고 다른 링크나 미링크 차트에는 번지지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  const targetBar = scenario.market.page({ symbol: CODE, period: "1m", venue: "combined" }).bars.at(-10)!;
  api.executions = [
    { orderNo: "0005001", code: CODE, name: "삼성전자", side: "buy", quantity: 10, price: 70_000, time: "093000", venue: "krx" },
  ];
  scenario.on(
    (url) => url.pathname === "/api/trading/executions/forensics",
    () => ({
      body: {
        date: "20261109",
        account: ACCOUNT,
        items: [
          {
            orderNo: "0005001",
            code: CODE,
            name: "삼성전자",
            side: "buy",
            time: "093000",
            fillAt: targetBar.t,
            price: 70_000,
            quantity: 10,
            collected: true,
            diagnosis: "whale_divergence",
            mfePct: 0.9,
            maePct: -0.1,
            slippageTicks: 0,
            preEntryCancelRatePct: 0,
            programDeltaMillionWon: 40,
            whaleNetDeltaMillionWon: 180,
            summary: "진입 1분 고래 순체결 +1.8억 · 5분 MFE +0.90%",
          },
        ],
      } satisfies ExecutionForensics,
    }),
  );

  await openOrderWindow(page, scenario, true, "krx", undefined, false, undefined, (windows) => [
    ...windows.map((window) => {
      if (window.id === "cell-0") return { ...window, link: "a" as const, symbol: CODE, period: "1m" as const, chartSettings: SETTINGS };
      if (window.id === "cell-1") return { ...window, link: "b" as const, symbol: CODE, period: "1m" as const, chartSettings: SETTINGS };
      if (window.kind === "order") return { ...window, link: "a" as const };
      return window;
    }),
    { id: "cell-2", link: null, kind: "chart" as const, symbol: CODE, venue: "combined" as const, period: "1m" as const, chartSettings: SETTINGS },
  ]);

  await expect(cell(page, 1)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page, 3)).toHaveAttribute("aria-busy", "false");

  await page.getByTestId("account-tab-fills").click();
  await page.getByTestId("account-fill").first().click();

  await expect(cell(page, 1).locator("[data-synced-crosshair]")).toBeVisible();
  await expect(cell(page, 1).locator("[data-synced-crosshair]")).toHaveAttribute("data-synced-time", String(targetBar.t));
  await expect(cell(page, 2).locator("[data-synced-crosshair]")).toBeHidden();
  await expect(cell(page, 3).locator("[data-synced-crosshair]")).toBeHidden();
});
