import type { Locator, Page } from "@playwright/test";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderCommand } from "../src/api/generated/OrderCommand";
import type { MarginPolicy } from "../src/api/generated/MarginPolicy";
import type { OrderSide } from "../src/api/generated/OrderSide";
import type { TradingOpenOrder } from "../src/api/generated/TradingOpenOrder";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingOrderable } from "../src/api/generated/TradingOrderable";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import type { Venue } from "../src/api/generated/Venue";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, windowTabs } from "./harness";

export const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
export const CODE = "005930";
export const ACCOUNT = "synthetic-account";
export const BASE = 70_000;

export type Write = { path: string; body: Record<string, unknown>; header: string | undefined };

export interface Api {
  open: TradingOpenOrder[];
  blocked: boolean;
  writes: Write[];
  placeReply: Partial<OrderCommand>;
  batchFailures: number;
  holdings: TradingHolding[];
  orderableQueries: string[];
  buyableFailure: { status: number; body: unknown } | null;
  policy: MarginPolicy;
  orderable: Partial<TradingOrderable>;
  policyWrites: Record<string, unknown>[];
  policyFailure: { status: number; body: unknown } | null;
  executions: TradingExecution[];
}

export const HELD: TradingHolding = { code: CODE, name: "삼성전자", quantity: 100_000, sellableQuantity: 100_000, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 };

export const win = (page: Page) => page.getByTestId("order-window");
export const status = (page: Page) => page.getByTestId("order-status");
export const cellAt = (page: Page, side: OrderSide, price: number): Locator => page.locator(`[data-order-cell][data-side="${side}"][data-price="${price}"]`);
export const chipAt = (page: Page, side: OrderSide, price: number): Locator => cellAt(page, side, price).getByTestId("order-chip");
export const writesTo = (api: Api, name: string): Write[] => api.writes.filter((w) => w.path === `/api/trading/commands/${name}`);

export const openOrder = (orderNo: string, side: OrderSide, price: number, openQuantity: number): TradingOpenOrder => ({
  orderNo, code: CODE, name: "삼성전자", side, quantity: openQuantity, price, openQuantity, status: "접수", orderedAt: "100000", originalOrderNo: null, venue: "krx",
});

export const commandOf = (kind: OrderCommand["kind"], patch: Partial<OrderCommand> = {}): OrderCommand => ({
  commandId: "cmd-synthetic-0001", accountRef: ACCOUNT, kind, code: CODE, venue: "krx", quantity: 10, price: BASE, targetOrderNo: null, state: "accepted", reason: null, orderNo: "0000099", reconciled: false, createdAt: 1, updatedAt: 1, ...patch,
});

export function pinQuote(scenario: Scenario, symbol: string, price: number, change = 0, priceByVenue: Partial<Record<Venue, number>> = {}): void {
  scenario.on((url) => url.pathname === "/api/quotes", (request) => {
    const query = new URL(request.url()).searchParams;
    const venue = (query.get("venue") ?? "combined") as Venue;
    return { body: (query.get("symbols") ?? "").split(",").flatMap((code) => {
      const quote = scenario.market.quote(code, venue);
      return quote ? [code === symbol ? { ...quote, price: priceByVenue[venue] ?? price, change } : quote] : [];
    }) };
  });
}

export function venueScene(scenario: Scenario, basePerVenue: Partial<Record<Venue, number>>, change = 0): void {
  pinQuote(scenario, CODE, BASE, change, basePerVenue);
  scenario.on((url) => url.pathname === `/api/symbols/${CODE}/order-book`, (request) => ({ body: snapshot(basePerVenue[(new URL(request.url()).searchParams.get("venue") ?? "combined") as Venue] ?? BASE) }));
}

export function nxtTraded(scenario: Scenario, nxtEnabled: boolean): void {
  scenario.reply(`/api/symbols/${CODE}`, { body: { code: CODE, name: "삼성전자", kind: "common", market: "kospi", nxtEnabled } });
}

export const feedSubscriptions = (scenario: Scenario, kind: FeedKind, venue: Venue) =>
  scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === kind && m.symbol === CODE && m.venue === venue);

export const requestedVenues = (scenario: Scenario, path: string): (string | null)[] =>
  scenario.requests.map((request) => new URL(request.url())).filter((url) => url.pathname === path).map((url) => url.searchParams.get("venue"));

export function ordersOn(scenario: Scenario): void {
  scenario.live.orders = { state: "on", accountRef: ACCOUNT, accountTail: "01", message: "주문 사용이 켜져 있습니다" };
}

export function tradingApi(scenario: Scenario, open: TradingOpenOrder[] = []): Api {
  const api: Api = { open, blocked: false, writes: [], placeReply: {}, batchFailures: 0, holdings: [HELD], orderableQueries: [], buyableFailure: null, policy: "cash_only", orderable: {}, policyWrites: [], policyFailure: null, executions: [] };
  const apiError = (message: string) => ({ status: 503, body: { error: { code: "internal", message, reason: null, retryAt: null, manualActionRequired: false } } });
  scenario.on((url) => url.pathname === "/api/trading/open-orders", () => ({ body: { accountRef: ACCOUNT, orders: api.open } }));
  scenario.on((url) => url.pathname === "/api/trading/balance", () => ({ body: { accountRef: ACCOUNT, holdings: api.holdings, totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 } }));
  scenario.on((url) => url.pathname === "/api/trading/executions", () => ({ body: { accountRef: ACCOUNT, day: "2026-11-18", executions: api.executions } }));
  scenario.on((url) => url.pathname === "/api/trading/commands", () => ({ body: { accountRef: ACCOUNT, blocked: api.blocked, commands: [] } }));
  scenario.on((url) => url.pathname === "/api/trading/orderable", (request) => {
    const side = new URL(request.url()).searchParams.get("side") ?? "";
    api.orderableQueries.push(side);
    if (side === "buy" && api.buyableFailure) return api.buyableFailure;
    const figures = { amount: 0, quantity: 0, cashAmount: 500_000_000, cashQuantity: 100_000, marginAmount: 1_500_000_000, marginQuantity: 300_000, ...api.orderable };
    const margined = api.policy === "allow_margin" && figures.marginAmount !== null && figures.marginQuantity !== null;
    const body: TradingOrderable = {
      accountRef: ACCOUNT, code: CODE, side: side as OrderSide, price: BASE, deposit: 520_000_000, unpaid: 0, stockRate: 100, accountRate: 40, appliedRate: 100, ...figures,
      policy: api.policy, amount: margined ? figures.marginAmount! : figures.cashAmount, quantity: margined ? figures.marginQuantity! : figures.cashQuantity,
    };
    return { body };
  });
  scenario.on((url) => url.pathname === "/api/system/orders/margin", (request) => {
    if (request.method() === "GET") return { body: { policy: api.policy } };
    const input = request.postDataJSON() as Record<string, unknown>;
    api.policyWrites.push(input);
    if (api.policyFailure) return api.policyFailure;
    api.policy = input.policy as MarginPolicy;
    return { body: { policy: api.policy } };
  });
  scenario.on((url, request) => url.pathname.startsWith("/api/trading/commands/") && request.method() === "POST", (request) => {
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    api.writes.push({ path, body, header: request.headers()["x-vally-order"] });
    if (path.endsWith("/place")) return { body: commandOf(body.side === "sell" ? "sell" : "buy", { quantity: Number(body.quantity), price: Number(body.price), ...api.placeReply }) };
    if (path.endsWith("/modify")) return { body: commandOf("modify", { price: Number(body.price), targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/cancel")) return { body: commandOf("cancel", { targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/reconcile")) { api.blocked = false; return { body: { accountRef: ACCOUNT, cleared: 1, openOrders: api.open, executions: [] } }; }
    if (api.batchFailures > 0) { api.batchFailures -= 1; return apiError("서버가 응답하지 못했습니다"); }
    return { body: { accountRef: ACCOUNT, blocked: false, commands: [commandOf("cancel")] } };
  });
  return api;
}

export function snapshot(base: number) {
  return {
    symbol: CODE,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: base + 100 * (i + 1), quantity: 10 + i })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: base - 100 * i, quantity: 20 + i })),
    totalAskQuantity: 1000,
    totalBidQuantity: 3000,
    afterHoursAskQuantity: null,
    afterHoursBidQuantity: null,
    bookTime: null,
  };
}

export async function openOrderWindow(page: Page, scenario: Scenario, withSecondChart = false, savedVenue: Venue = "krx", limits: { upper: number | null; lower: number | null } = { upper: 91_000, lower: 49_000 }, bookFails = false): Promise<void> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...(withSecondChart ? [{ id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } satisfies LayoutWindow] : []),
    ...layout.windows.filter((w) => w.kind !== "chart"),
    { id: "order", link: null, kind: "order", venue: savedVenue },
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  pinQuote(scenario, CODE, BASE);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: limits.upper, lowerLimit: limits.lower, marketCap: null, listedShares: null, per: null, pbr: null, roe: null, eps: null, bps: null, foreignExhaustionRate: null, high52w: null, low52w: null } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, bookFails ? { status: 503, body: { error: { code: "internal", message: "호가 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } } : { body: snapshot(BASE) });
  scenario.reply((url) => url.pathname === "/api/symbols/000660/order-book", { body: { ...snapshot(BASE), symbol: "000660" } });
  scenario.reply((url) => url.pathname === "/api/symbols/000660/fundamentals", { body: { symbol: "000660", upperLimit: null, lowerLimit: null } });
  for (const symbol of [CODE, "000660"]) scenario.on((url) => url.pathname === `/api/symbols/${symbol}/trades`, (request) => ({ body: { symbol, venue: new URL(request.url()).searchParams.get("venue") ?? "combined", trades: [], skippedRows: 0 } }));
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await windowTabs(page).getByRole("tab", { name: /^호가주문/ }).click();
  await expect(win(page)).toBeVisible();
  if (!bookFails) await expect(page.getByTestId("price-ladder").locator(".mw-lr")).toHaveCount(20);
}

export async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("화면에 보이지 않는 요소입니다");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function dragChip(page: Page, chip: Locator, to: { x: number; y: number }, release = true): Promise<void> {
  const from = await center(chip);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (release) await page.mouse.up();
}

