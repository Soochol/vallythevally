import type { Page } from "@playwright/test";
import type { ClientMessage } from "../src/api/generated/ClientMessage";
import type { FeedTrade } from "../src/api/generated/FeedTrade";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { TradePrint } from "../src/api/generated/TradePrint";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const at = (clock: string): number => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const print = (time: string, price: number, quantity: number, exchange: Venue | null): TradePrint => ({ time, price, quantity, exchange });
const live = (clock: string, price: number, qty: number, venue: Venue | null = "krx", strength: number | null = null): FeedTrade => ({ t: at(clock), price, qty, venue, strength });

const TODAY: TradePrint[] = [
  print("10:00:03", 71_300, -20, "nxt"),
  print("10:00:02", 71_200, 15, "krx"),
  print("10:00:01", 71_100, 700, "krx"),
  print("09:59:59", 71_000, -9, "nxt"),
];

const tradesOf = (scenario: Scenario, venue: Venue) => scenario.on(
  (url) => url.pathname === "/api/symbols/005930/trades",
  (request) => {
    const asked = new URL(request.url()).searchParams.get("venue") as Venue;
    const trades = asked === "combined" ? TODAY : TODAY.filter((t) => t.exchange === asked);
    return { body: { symbol: "005930", venue: asked === "nxt" && venue === "combined" ? "combined" : asked, trades, skippedRows: 0 } };
  },
);

const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const rows = (page: Page) => page.getByTestId("trade-row");
type FeedRequest = Extract<ClientMessage, { type: "subscribe_feed" }>;
const feedRequests = (scenario: Scenario): FeedRequest[] => scenario.live.messages.filter((m): m is FeedRequest => m.type === "subscribe_feed" && m.kind === "trades");
const feedSub = (scenario: Scenario): string | undefined => feedRequests(scenario).at(-1)?.sub;

async function openTradesWindow(page: Page, scenario: Scenario): Promise<string> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [{ id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS }, ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await addButton(page).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^체결/ }).click();
  await expect(page.getByTestId("trades-window")).toBeVisible();
  await page.mouse.move(2, 2);
  await expect.poll(() => feedSub(scenario)).toBeDefined();
  return feedSub(scenario)!;
}

const emit = (scenario: Scenario, sub: string, trades: FeedTrade[]) => scenario.live.emit({ type: "feed_trades", sub, seq: 1, trades });

test("당일 체결을 먼저 구독한 뒤 조회하고 겹치는 행은 실시간만 남기며 새 체결이 맨 위에 붙는다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).first()).toContainText("10:00:03");
  expect(feedRequests(scenario)[0]).toMatchObject({ symbol: "005930", kind: "trades", venue: "combined" });

  emit(scenario, sub, [live("10:00:02", 71_250, 30, "krx", 112.34), live("10:00:04", 71_400, -5, "krx", 113.5)]);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId("trades-window")).not.toContainText("10:00:03");
  await expect(rows(page).nth(0)).toContainText("10:00:04");
  await expect(rows(page).nth(0)).toContainText("71,400");
  await expect(rows(page).nth(1)).toContainText("10:00:02");
  await expect(rows(page).nth(2)).toContainText("10:00:01");
  await expect(rows(page).nth(3)).toContainText("09:59:59");
  await expect(page.getByTestId("trade-strength")).toHaveText("113.50%");
  await expect(rows(page).nth(0)).toHaveAttribute("data-side", "sell");

  emit(scenario, sub, [live("10:00:05", 71_500, 3_000, "krx")]);
  await expect(rows(page).first()).toContainText("10:00:05");
  await expect(rows(page).first()).toContainText("대량");
});

test("마우스를 올린 동안 목록이 밀리지 않고 새 체결 건수를 알리며 단추를 누르면 이어 붙는다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);

  await page.getByTestId("trade-tape").hover();
  emit(scenario, sub, [live("10:00:04", 71_400, 5), live("10:00:05", 71_500, 6)]);
  await expect(page.getByTestId("trade-pending")).toHaveText("새 체결 2건");
  await expect(rows(page).first()).toContainText("10:00:03");
  await expect(rows(page)).toHaveCount(4);

  await page.getByTestId("trade-pending").click();
  await expect(rows(page).first()).toContainText("10:00:05");
  await expect(rows(page)).toHaveCount(6);
  await expect(page.getByTestId("trade-pending")).toHaveCount(0);

  emit(scenario, sub, [live("10:00:06", 71_600, 7)]);
  await expect(page.getByTestId("trade-pending")).toHaveText("새 체결 1건");
  await page.mouse.move(2, 2);
  await expect(page.getByTestId("trade-pending")).toHaveCount(0);
  await expect(rows(page).first()).toContainText("10:00:06");
});

test("KRX를 고르면 NXT 체결이 보이지 않는다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByText("−20")).toHaveCount(0);

  await pickDesktopVenue(page, "KRX");
  await expect.poll(() => feedRequests(scenario).at(-1)).toMatchObject({ venue: "krx" });
  await expect(rows(page)).toHaveCount(2);
  const krxSub = feedSub(scenario)!;
  expect(krxSub).not.toBe(sub);

  emit(scenario, krxSub, [live("10:00:04", 71_400, 5, "nxt"), live("10:00:05", 71_500, 6, "krx")]);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText("71,500");
  await expect(page.getByTestId("trades-window")).not.toContainText("71,400");
  await expect(page.getByTestId("trade-integrated-only")).toHaveCount(0);
});

test("선택한 거래소로 조회되지 않아 통합으로 왔으면 띠에 알린다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  await openTradesWindow(page, scenario);
  await pickDesktopVenue(page, "NXT");
  await expect(page.getByTestId("trade-integrated-only")).toHaveText("통합 기준");
});

test("끊김과 이어짐은 목록에 구분 줄 하나로 보이고 최소 금액을 고르면 작은 체결을 감춘다", async ({ page, scenario }) => {
  tradesOf(scenario, "combined");
  const sub = await openTradesWindow(page, scenario);
  await expect(rows(page)).toHaveCount(4);

  scenario.live.emit({ type: "feed_link", sub, live: false, at: at("10:00:10") });
  await expect(page.getByTestId("trade-gap")).toHaveCount(1);
  await expect(page.getByTestId("trade-gap")).toContainText("끊김 10:00:10");
  scenario.live.emit({ type: "feed_link", sub, live: true, at: at("10:00:40") });
  await expect(page.getByTestId("trade-gap")).toHaveText("끊김 10:00:10 → 이어짐 10:00:40");
  await expect(page.getByTestId("trade-gap")).toHaveCount(1);

  await page.getByRole("group", { name: "최소 체결 금액" }).getByRole("button", { name: "3천만" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("71,100");
});
