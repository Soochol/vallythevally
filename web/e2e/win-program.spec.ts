import type { Page } from "@playwright/test";
import type { FeedProgramRow } from "../src/api/generated/FeedProgramRow";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ProgramTradePoint } from "../src/api/generated/ProgramTradePoint";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const kstSeconds = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;

const point = (time: string, netQuantity: number): ProgramTradePoint => ({ time, price: 70_000, buyQuantity: 100, sellQuantity: 60, netQuantity, buyAmount: 0, sellAmount: 0, netAmount: netQuantity * 70_000_000 });
const liveRow = (clock: string, netQty: number, netQtyChange: number, netAmount: number): FeedProgramRow =>
  ({ t: kstSeconds(clock), price: 70_100, sellQty: 3_000, sellAmount: 0, buyQty: 5_000, buyAmount: 0, netQty, netQtyChange, netAmount, netAmountChange: 0 });

function linkStock(scenario: Scenario, symbol: string, points: ProgramTradePoint[]) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [{ id: "cell-0", link: "a", kind: "chart", symbol, venue: "combined", period: "D", chartSettings: SETTINGS }, ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  scenario.reply((url) => url.pathname === `/api/symbols/${symbol}/program-trades`, { body: { symbol, points, skippedRows: 0 } });
}

async function openProgramWindow(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^프로그램 체결/ }).click();
}

async function emitLive(scenario: Scenario, frame: (sub: string) => Parameters<Scenario["live"]["emit"]>[0]) {
  await expect.poll(() => scenario.live.messages.some((m) => m.type === "subscribe_feed" && m.kind === "program")).toBe(true);
  const subscribe = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "program");
  if (subscribe?.type !== "subscribe_feed") throw new Error("프로그램 구독이 없습니다");
  scenario.live.emit(frame(subscribe.sub));
}

const rowsOf = (page: Page) => page.getByTestId("program-row");

test("조회 행 뒤에 실시간 행이 붙고 겹치는 조회 행은 사라지며 누적 숫자와 막대 방향이 맞다", async ({ page, scenario }) => {
  linkStock(scenario, "005930", [point("09:00:00", 10), point("09:01:00", 30), point("09:02:00", 20)]);
  await openProgramWindow(page);
  await expect(rowsOf(page)).toHaveCount(3);
  await expect(page.getByTestId("program-net-qty")).toHaveText("+20주");

  await emitLive(scenario, (sub) => ({ type: "feed_program", sub, row: liveRow("09:02:00", 25, 5, 1_050) }));
  await emitLive(scenario, (sub) => ({ type: "feed_program", sub, row: liveRow("09:03:00", 15, -10, 1_050) }));

  await expect(rowsOf(page)).toHaveCount(4);
  await expect(rowsOf(page).evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-source")} ${row.querySelector(".pg-time")?.textContent}`))).resolves.toEqual([
    "live 09:03:00",
    "live 09:02:00",
    "history 09:01:00",
    "history 09:00:00",
  ]);
  await expect(page.getByTestId("program-net-qty")).toHaveText("+15주");
  await expect(page.getByTestId("program-net-amount")).toHaveText("+10.50억원");
  await expect(page.getByTestId("program-buy-qty")).toHaveText("5,000주");
  await expect(page.getByTestId("program-sell-qty")).toHaveText("3,000주");
  await expect(rowsOf(page).nth(0).getByTestId("program-bar")).toHaveAttribute("data-direction", "sell");
  await expect(rowsOf(page).nth(1).getByTestId("program-bar")).toHaveAttribute("data-direction", "buy");
  await expect(rowsOf(page).nth(0).getByTestId("program-change")).toContainText("−10");
  await expect(rowsOf(page).nth(1).getByTestId("program-change")).toContainText("+5");
});

test("연결이 끊겼다 이어지면 실시간 행 사이에 끊김 줄이 생긴다", async ({ page, scenario }) => {
  linkStock(scenario, "005930", [point("09:00:00", 10)]);
  await openProgramWindow(page);
  await emitLive(scenario, (sub) => ({ type: "feed_program", sub, row: liveRow("09:01:00", 12, 2, 100) }));
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(page.getByTestId("program-gap")).toHaveCount(0);
  await emitLive(scenario, (sub) => ({ type: "feed_link", sub, live: false, at: kstSeconds("09:02:00") }));
  await emitLive(scenario, (sub) => ({ type: "feed_program", sub, row: liveRow("09:03:00", 20, 8, 200) }));
  await expect(page.getByTestId("program-gap")).toHaveCount(1);
  await expect(page.getByTestId("program-gap")).toContainText("09:02:00");
  await expect(rowsOf(page)).toHaveCount(3);
});

test("프로그램매매 자료가 없는 종목은 빈 상태를 보인다", async ({ page, scenario }) => {
  linkStock(scenario, "0000D0", []);
  await openProgramWindow(page);
  await expect(page.getByText("이 종목은 프로그램 매매 자료가 없습니다")).toBeVisible();
  await expect(rowsOf(page)).toHaveCount(0);
});

test("앱 전체 거래소가 KRX이면 통합 표시가 붙는다", async ({ page, scenario }) => {
  linkStock(scenario, "005930", [point("09:00:00", 10)]);
  await openProgramWindow(page);
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(page.locator(".pg-badge .mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "KRX");
  await expect(page.locator(".pg-badge .mw-integrated")).toHaveText("통합");
});
