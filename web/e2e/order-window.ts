import type { Locator, Page, Request } from "@playwright/test";
import type { FeedKind } from "../src/api/generated/FeedKind";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { OrderCommand } from "../src/api/generated/OrderCommand";
import type { MarginPolicy } from "../src/api/generated/MarginPolicy";
import type { OrdersAccount } from "../src/api/generated/OrdersAccount";
import type { OrderSide } from "../src/api/generated/OrderSide";
import type { TradingOpenOrder } from "../src/api/generated/TradingOpenOrder";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import type { TradingOrderable } from "../src/api/generated/TradingOrderable";
import type { TradingHolding } from "../src/api/generated/TradingHolding";
import type { Venue } from "../src/api/generated/Venue";
import { daySummaryOf } from "./fixtures/scenario";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, windowTabs } from "./harness";

export const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
export const CODE = "005930";
export const ACCOUNT = "synthetic-account";
export const BASE = 70_000;
export const FUNDAMENTAL_FIGURES = { marketCap: 82_400_000_000, listedShares: null, per: 14.21, pbr: 1.1, roe: null, eps: null, bps: null, foreignExhaustionRate: 54.12, high52w: 88_000, low52w: 51_000 };

export const INFO_PAGE_1 = ["시가", "고가", "저가", "기준가", "거래량", "거래대금"];
export const INFO_PAGE_2 = ["상한가", "하한가", "상승VI", "하락VI", "시가총액"];
export const INFO_PAGE_2_VALUES = ["91,000", "49,000", "76,900", "62,900", "824억"];
export const infoLabels = (page: Page): Locator => page.getByTestId("ladder-info").locator(":scope > span:first-child");
export const infoValues = (page: Page): Locator => page.getByTestId("ladder-info").locator(":scope > b");
export const infoCard = (page: Page): Locator => page.getByTestId("ladder-info-card");
export const infoTab = (page: Page, name: "시세" | "종목"): Locator => infoCard(page).getByRole("tab", { name });

export type Write = { path: string; body: Record<string, unknown>; header: string | undefined; account: string | null };

export interface AccountData {
  open: TradingOpenOrder[];
  holdings: TradingHolding[];
  executions: TradingExecution[];
  orderable: Partial<TradingOrderable>;
}

export type Seen = { path: string; account: string | null };

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
  accounts: Record<string, AccountData>;
  seen: Seen[];
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
  pinDaySummary(scenario, symbol, price, change, priceByVenue);
}

function pinDaySummary(scenario: Scenario, symbol: string, price: number, change: number, priceByVenue: Partial<Record<Venue, number>>): void {
  scenario.on((url) => url.pathname === `/api/symbols/${symbol}/day-summary`, (request) => {
    const venue = (new URL(request.url()).searchParams.get("venue") ?? "combined") as Venue;
    const quote = scenario.market.quote(symbol, venue);
    return { body: quote ? daySummaryOf({ ...quote, price: priceByVenue[venue] ?? price, change }) : null };
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

export const MARKET_KEY = "k1";
export const SECOND_ACCOUNT = "synthetic-account-b";

export const otherAccount = (patch: Partial<OrdersAccount> = {}): OrdersAccount => ({ keyId: "k2", broker: "kiwoom", alias: "위탁 2", market: false, state: "on", accountRef: SECOND_ACCOUNT, accountTail: "05", ...patch });

export const KIS_ACCOUNT = "synthetic-account-kis";

export const kisAccount = (patch: Partial<OrdersAccount> = {}): OrdersAccount => ({ keyId: "kis1", broker: "kis", alias: "한투 1", market: false, state: "on", accountRef: KIS_ACCOUNT, accountTail: "34", ...patch });

export function ordersOn(scenario: Scenario, others: OrdersAccount[] = [], marketTail = "01"): void {
  const market: OrdersAccount = { keyId: MARKET_KEY, broker: "kiwoom", alias: "키 1", market: true, state: "on", accountRef: ACCOUNT, accountTail: marketTail };
  scenario.live.orders = { state: "on", accountRef: ACCOUNT, accountTail: marketTail, message: "주문 사용이 켜져 있습니다", accounts: [market, ...others] };
}

export const accountData = (patch: Partial<AccountData> = {}): AccountData => ({ open: [], holdings: [], executions: [], orderable: {}, ...patch });

export function tradingApi(scenario: Scenario, open: TradingOpenOrder[] = []): Api {
  const api: Api = { open, blocked: false, writes: [], placeReply: {}, batchFailures: 0, holdings: [HELD], orderableQueries: [], buyableFailure: null, policy: "cash_only", orderable: {}, policyWrites: [], policyFailure: null, executions: [], accounts: {}, seen: [] };
  const apiError = (message: string) => ({ status: 503, body: { error: { code: "internal", message, reason: null, retryAt: null, manualActionRequired: false } } });
  const scopeOf = (request: Request) => {
    const url = new URL(request.url());
    const account = url.searchParams.get("account");
    api.seen.push({ path: url.pathname, account });
    const other = account === null ? undefined : api.accounts[account];
    return { ref: account ?? ACCOUNT, data: other ?? { open: api.open, holdings: api.holdings, executions: api.executions, orderable: api.orderable } };
  };
  scenario.on((url) => url.pathname === "/api/trading/open-orders", (request) => { const { ref, data } = scopeOf(request); return { body: { accountRef: ref, orders: data.open } }; });
  scenario.on((url) => url.pathname === "/api/trading/balance", (request) => { const { ref, data } = scopeOf(request); return { body: { accountRef: ref, holdings: data.holdings, creditHoldings: [], totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 } }; });
  scenario.on((url) => url.pathname === "/api/trading/executions", (request) => { const { ref, data } = scopeOf(request); return { body: { accountRef: ref, day: "2026-11-18", executions: data.executions } }; });
  scenario.on((url) => url.pathname === "/api/trading/commands", (request) => ({ body: { accountRef: scopeOf(request).ref, blocked: api.blocked, commands: [] } }));
  scenario.on((url) => url.pathname === "/api/trading/orderable", (request) => {
    const { ref, data } = scopeOf(request);
    const side = new URL(request.url()).searchParams.get("side") ?? "";
    api.orderableQueries.push(side);
    if (side === "buy" && api.buyableFailure) return api.buyableFailure;
    const figures = { amount: 0, quantity: 0, cashAmount: 500_000_000, cashQuantity: 100_000, marginAmount: 1_500_000_000, marginQuantity: 300_000, ...data.orderable };
    const margined = api.policy === "allow_margin" && figures.marginAmount !== null && figures.marginQuantity !== null;
    const body: TradingOrderable = {
      accountRef: ref, code: CODE, side: side as OrderSide, price: BASE, deposit: 520_000_000, unpaid: 0, stockRate: 100, accountRate: 40, appliedRate: 100, ...figures,
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
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    const account = typeof body.account === "string" ? body.account : url.searchParams.get("account");
    const ref = account ?? ACCOUNT;
    api.writes.push({ path, body, header: request.headers()["x-vally-order"], account });
    if (path.endsWith("/place")) return { body: commandOf(body.side === "sell" ? "sell" : "buy", { accountRef: ref, quantity: Number(body.quantity), price: Number(body.price), ...api.placeReply }) };
    if (path.endsWith("/modify")) return { body: commandOf("modify", { accountRef: ref, price: Number(body.price), targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/cancel")) return { body: commandOf("cancel", { accountRef: ref, targetOrderNo: String(body.orderNo) }) };
    if (path.endsWith("/reconcile")) { api.blocked = false; return { body: { accountRef: ref, cleared: 1, openOrders: api.open, executions: [] } }; }
    if (api.batchFailures > 0) { api.batchFailures -= 1; return apiError("서버가 응답하지 못했습니다"); }
    return { body: { accountRef: ref, blocked: false, commands: [commandOf("cancel", { accountRef: ref })] } };
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

export const askAtLastSnapshot = (spreadGap = 0): ReturnType<typeof snapshot> => ({
  ...snapshot(BASE),
  asks: Array.from({ length: 10 }, (_, i) => ({ price: BASE + 100 * i, quantity: 10 + i })),
  bids: Array.from({ length: 10 }, (_, i) => ({ price: BASE - 100 - spreadGap - 100 * i, quantity: 20 + i })),
});

type DockTree = { kind: "group"; id: string; tabs: string[]; active: string } | { kind: "split"; dir: "row" | "column"; ratio: number; first: DockTree; second: DockTree };

function ordersBelowCharts(windows: readonly LayoutWindow[]): DockTree {
  const left = windows.filter((window) => window.kind === "chart" || window.kind === "order").map((window) => window.id);
  const right = windows.filter((window) => window.kind !== "chart" && window.kind !== "order").map((window) => window.id);
  const groups: DockTree[] = left.map((id, index) => ({ kind: "group", id: `g${index + 1}`, tabs: [id], active: id }));
  const stack = (rest: DockTree[]): DockTree => rest.length === 1 ? rest[0]! : { kind: "split", dir: "column", ratio: 1 / rest.length, first: rest[0]!, second: stack(rest.slice(1)) };
  const column = stack(groups);
  return right.length ? { kind: "split", dir: "row", ratio: 0.72, first: column, second: { kind: "group", id: `g${left.length + 1}`, tabs: right, active: right[0]! } } : column;
}

export async function openOrderWindow(page: Page, scenario: Scenario, withSecondChart = false, savedVenue: Venue = "krx", limits: { upper: number | null; lower: number | null } = { upper: 91_000, lower: 49_000 }, bookFails = false, book: ReturnType<typeof snapshot> = snapshot(BASE), arrange: (windows: LayoutWindow[]) => LayoutWindow[] = (windows) => windows): Promise<void> {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS },
    ...(withSecondChart ? [{ id: "cell-1", link: null, kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } satisfies LayoutWindow] : []),
    ...layout.windows.filter((w) => w.kind !== "chart"),
    { id: "order", link: null, kind: "order", venue: savedVenue },
  ];
  const arranged = arrange(windows);
  scenario.documents.saveLayout({ ...layout, windows: arranged, placement: { v: 1, dock: { root: ordersBelowCharts(arranged), floats: [] }, canvas: null }, revision: layout.revision + 1 });
  pinQuote(scenario, CODE, BASE);
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/fundamentals`, { body: { symbol: CODE, upperLimit: limits.upper, lowerLimit: limits.lower, ...FUNDAMENTAL_FIGURES } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/order-book`, bookFails ? { status: 503, body: { error: { code: "internal", message: "호가 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } } : { body: book });
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

