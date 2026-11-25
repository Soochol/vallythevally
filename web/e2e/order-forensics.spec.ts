import type { ExecutionForensics } from "../src/api/generated/ExecutionForensics";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import { cell, expect, test } from "./harness";
import { ACCOUNT, CODE, openOrderWindow, ordersOn, SETTINGS, tradingApi } from "./order-window";

const OTHER_CODE = "000660";

function intradayArrangement(windows: LayoutWindow[]): LayoutWindow[] {
  return windows.map((window) => {
    if (window.kind === "chart") return { ...window, link: "a", period: "1m", chartSettings: SETTINGS };
    if (window.kind === "order") return { ...window, link: "a" };
    return window;
  });
}

test("체결 팝오버를 열 때만 해부를 조회하고 진단 뱃지·카드 표시 및 차트 시점 점프가 동작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  const targetBar = scenario.market.page({ symbol: OTHER_CODE, period: "1m", venue: "combined" }).bars.at(-10)!;
  const samsungBar = scenario.market.page({ symbol: CODE, period: "1m", venue: "combined" }).bars.at(-20)!;

  const executions: TradingExecution[] = [
    { orderNo: "0001001", code: CODE, name: "삼성전자", side: "buy", quantity: 10, price: 70_000, time: "091500", venue: "krx" },
    { orderNo: "0001002", code: CODE, name: "삼성전자", side: "buy", quantity: 8, price: 70_200, time: "092500", venue: "krx" },
    { orderNo: "0001003", code: OTHER_CODE, name: "SK하이닉스", side: "buy", quantity: 5, price: 180_500, time: "094015", venue: "krx" },
  ];
  api.executions = executions;

  const forensics: ExecutionForensics = {
    date: "20261109",
    account: ACCOUNT,
    items: [
      {
        orderNo: "0001001",
        code: CODE,
        name: "삼성전자",
        side: "buy",
        time: "091500",
        fillAt: samsungBar.t,
        price: 70_000,
        quantity: 10,
        collected: true,
        diagnosis: "iceberg_support",
        mfePct: 1.15,
        maePct: -0.1,
        slippageTicks: 0,
        preEntryCancelRatePct: 0,
        programDeltaMillionWon: 85,
        whaleNetDeltaMillionWon: 40,
        summary: "진입 직전 아이스버그 지지 포착 · 5분 MFE +1.15%",
      },
      {
        orderNo: "0001002",
        code: CODE,
        name: "삼성전자",
        side: "buy",
        time: "092500",
        fillAt: samsungBar.t + 60,
        price: 70_200,
        quantity: 8,
        collected: true,
        diagnosis: "whale_divergence",
        mfePct: 0.92,
        maePct: -0.15,
        slippageTicks: 1,
        preEntryCancelRatePct: 12.5,
        programDeltaMillionWon: 120,
        whaleNetDeltaMillionWon: 240,
        summary: "진입 1분 고래 순체결 +2.4억 · 5분 MFE +0.92%",
      },
      {
        orderNo: "0001003",
        code: OTHER_CODE,
        name: "SK하이닉스",
        side: "buy",
        time: "094015",
        fillAt: targetBar.t + 15,
        price: 180_500,
        quantity: 5,
        collected: true,
        diagnosis: "spoof_chase_trap",
        mfePct: 0.05,
        maePct: -1.45,
        slippageTicks: 2,
        preEntryCancelRatePct: 88.5,
        programDeltaMillionWon: -150,
        whaleNetDeltaMillionWon: -90,
        summary: "진입 직전 허수 취소율 88.5% 감지 · 5분 MAE -1.45%",
      },
    ],
  };

  scenario.on((url) => url.pathname === "/api/trading/executions/forensics", () => ({ body: forensics }));

  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, intradayArrangement);

  const forensicsCalls = () => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/executions/forensics").length;
  expect(forensicsCalls()).toBe(0);

  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-panel")).toBeVisible();
  expect(forensicsCalls()).toBeGreaterThanOrEqual(1);

  const badges = page.getByTestId("fill-diagnosis-badge");
  await expect(badges).toHaveCount(3);
  await expect(badges.filter({ hasText: "아이스버그 지지" })).toHaveCount(1);
  await expect(badges.filter({ hasText: "고래 다이버전스" })).toHaveCount(1);
  await expect(badges.filter({ hasText: "허수벽 추격 함정" })).toHaveCount(1);

  const trapRow = page.getByTestId("account-fill").filter({ hasText: "허수벽 추격 함정" });
  await trapRow.click();

  const card = page.getByTestId("execution-forensic-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-diagnosis", "spoof_chase_trap");
  await expect(card.getByTestId("forensic-mfe-mae")).toHaveText("+0.05% / -1.45%");
  await expect(card.getByTestId("forensic-cancel-rate")).toHaveText("88.5%");
  await expect(card.getByTestId("forensic-program-delta")).toHaveText("-1.5억");
  await expect(card.getByTestId("forensic-slippage")).toHaveText("+2틱");
  await expect(card.getByTestId("forensic-summary")).toHaveText("진입 직전 허수 취소율 88.5% 감지 · 5분 MAE -1.45%");

  await expect(cell(page)).toHaveAttribute("aria-label", /SK하이닉스/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const syncedCrosshair = cell(page).locator("[data-synced-crosshair]");
  await expect(syncedCrosshair).toBeVisible();
  await expect(syncedCrosshair).toHaveAttribute("data-synced-time", String(targetBar.t));
});

test("수집 데이터가 없는 체결은 미수집 안내를 카드로 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  const executions: TradingExecution[] = [
    { orderNo: "0002001", code: CODE, name: "삼성전자", side: "sell", quantity: 3, price: 70_100, time: "101000", venue: "krx" },
  ];
  api.executions = executions;

  const forensics: ExecutionForensics = {
    date: "20261109",
    account: ACCOUNT,
    items: [
      {
        orderNo: "0002001",
        code: CODE,
        name: "삼성전자",
        side: "sell",
        time: "101000",
        fillAt: Math.floor(scenario.now / 1000),
        price: 70_100,
        quantity: 3,
        collected: false,
        diagnosis: "neutral",
        mfePct: null,
        maePct: null,
        slippageTicks: null,
        preEntryCancelRatePct: null,
        programDeltaMillionWon: null,
        whaleNetDeltaMillionWon: null,
        summary: "수집 데이터가 없어 체결 해부를 표시할 수 없습니다",
      },
    ],
  };

  scenario.on((url) => url.pathname === "/api/trading/executions/forensics", () => ({ body: forensics }));
  await openOrderWindow(page, scenario);
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("fill-diagnosis-badge")).toHaveText("미수집");
  await page.getByTestId("account-fill").first().click();

  const card = page.getByTestId("execution-forensic-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-collected", "false");
  await expect(card).toContainText("미수집 종목");
  await expect(card).toContainText("수집 데이터가 없어 체결 해부를 표시할 수 없습니다");
});
