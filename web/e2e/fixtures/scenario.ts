import type { ApiError } from "../../src/api/generated/ApiError";
import { isPeriod } from "../../src/lib/symbol";
import { parseUiState } from "../../src/persist/uiState";
import type { BrowserContext, Request, Route, WebSocketRoute } from "@playwright/test";
import type { Bar } from "../../src/api/generated/Bar";
import type { BarsPage } from "../../src/api/generated/BarsPage";
import type { ClientMessage } from "../../src/api/generated/ClientMessage";
import type { CollectorAccess } from "../../src/api/generated/CollectorAccess";
import type { ConnectionStatus } from "../../src/api/generated/ConnectionStatus";
import type { FinancialsPage } from "../../src/api/generated/FinancialsPage";
import type { HeatmapThemes } from "../../src/api/generated/HeatmapThemes";
import type { JumpBarsPage } from "../../src/api/generated/JumpBarsPage";
import type { AccountStatus } from "../../src/api/generated/AccountStatus";
import type { KiwoomKey } from "../../src/api/generated/KiwoomKey";
import type { KiwoomKeyList } from "../../src/api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../../src/api/generated/KiwoomLinkStatus";
import type { MarketSourceStatus } from "../../src/api/generated/MarketSourceStatus";
import type { KiwoomUsage } from "../../src/api/generated/KiwoomUsage";
import type { ScreenerStatus } from "../../src/api/generated/ScreenerStatus";
import type { SyncStatus } from "../../src/api/generated/SyncStatus";
import type { SystemSettings } from "../../src/api/generated/SystemSettings";
import type { Drawing } from "../../src/api/generated/Drawing";
import type { DrawingInput } from "../../src/api/generated/DrawingInput";
import type { Layout } from "../../src/api/generated/Layout";
import type { LayoutInput } from "../../src/api/generated/LayoutInput";
import type { LayoutWindow } from "../../src/api/generated/LayoutWindow";
import type { KisAccountListing } from "../../src/api/generated/KisAccountListing";
import type { OrdersAccount } from "../../src/api/generated/OrdersAccount";
import type { OrdersAccountCheck } from "../../src/api/generated/OrdersAccountCheck";
import type { OrdersStatus } from "../../src/api/generated/OrdersStatus";
import type { OrdersSwitchInput } from "../../src/api/generated/OrdersSwitchInput";
import type { Period } from "../../src/api/generated/Period";
import type { RankingPage } from "../../src/api/generated/RankingPage";
import type { Screens } from "../../src/api/generated/Screens";
import type { ServerMessage } from "../../src/api/generated/ServerMessage";
import type { Quote } from "../../src/api/generated/Quote";
import type { QuoteTotalsPage } from "../../src/api/generated/QuoteTotalsPage";
import type { SymbolDaySummary } from "../../src/api/generated/SymbolDaySummary";
import type { SymbolInfo } from "../../src/api/generated/SymbolInfo";
import type { UiState } from "../../src/api/generated/UiState";
import type { Venue } from "../../src/api/generated/Venue";
import type { Watchlist } from "../../src/api/generated/Watchlist";
import type { Watchlists } from "../../src/api/generated/Watchlists";
import { etfBaseline } from "./etf-data";
import { KIWOOM_MARKET_SOURCE } from "./market-source";
import { boardOf, EMPTY_KIWOOM_CATALOG, kiwoomBoardOf, parseOrder, parseSource, type KiwoomCatalog } from "../../dev/fakeHeatmapBoard";
import { marketOverviewBaseline } from "./market-data";
import { PublicMode } from "./public-mode-data";
import { barsPage, findSymbol, publicInfo, quoteOf, resolveVenue, search, SYMBOLS } from "../../dev/fakeMarket";

export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
const FIRST_WATCHLIST_ID = "01900000-0000-7000-8000-000000000002";
export type FixtureReply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Matcher = string | ((url: URL, request: Request) => boolean);
type Handler = (request: Request) => FixtureReply | Promise<FixtureReply>;
type Subscription = Extract<ClientMessage, { type: "subscribe" }>;
const clone = <T>(value: T): T => structuredClone(value);
const error = (status: number, code: ApiError["error"]["code"], message: string): FixtureReply => ({ status, body: { error: { code, message, reason: null, retryAt: null, manualActionRequired: false } } satisfies ApiError });
export type ChartWindow = Extract<LayoutWindow, { kind: "chart" }>;
export function firstChart(layout: { windows: LayoutWindow[] }): ChartWindow {
  const chart = layout.windows.find((w): w is ChartWindow => w.kind === "chart");
  if (!chart) throw new Error("레이아웃에 차트 창이 없습니다");
  return chart;
}
export function withFirstChart(layout: { windows: LayoutWindow[] }, patch: Partial<Omit<ChartWindow, "id" | "kind">>): LayoutWindow[] {
  const chart = firstChart(layout);
  return layout.windows.map((w) => (w === chart ? { ...chart, ...patch } : w));
}
export type WatchlistSeed = Omit<Watchlist, "groups"> & Partial<Pick<Watchlist, "groups">>;
const isScenarioPath = (pathname: string) => pathname.startsWith("/api/") || pathname.startsWith("/v1/");
const matches = (match: Matcher, request: Request) => typeof match === "string" ? new URL(request.url()).pathname === match : match(new URL(request.url()), request);

export class UserDocuments {
  private layouts = new Map<string, Layout>([[DEFAULT_LAYOUT_ID, { id: DEFAULT_LAYOUT_ID, name: "기본", sync: { crosshair: true, scroll: true, crosshairScope: "all" }, windows: [{ id: "cell-0", link: null, kind: "chart", symbol: "IDX:001", venue: null, period: "D", chartSettings: { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } }, { id: "watchlist", link: null, kind: "watchlist" }, { id: "screener", link: null, kind: "screener" }], placement: {}, updatedAt: 0, revision: 0 }]]);
  private watchlistValue: Watchlists = { lists: [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: [], groups: [] }], revision: 0 };
  private screenValue: Screens = { screens: [], revision: 0 };
  private heatmapThemeValue: HeatmapThemes = { themes: [], revision: 0 };
  private uiValue: UiState = { lastLayoutId: DEFAULT_LAYOUT_ID, theme: "dark", revision: 0 };
  private drawingValues = new Map<string, Drawing>();
  private drawingRevisions = new Map<string, number>();

  layout(id = DEFAULT_LAYOUT_ID): Layout {
    const value = this.layouts.get(id);
    if (!value) throw new Error(`Missing layout fixture: ${id}`);
    return { ...clone(value), sync: { ...value.sync, crosshairScope: value.sync.crosshairScope ?? "all" } };
  }
  layoutSummaries() { return [...this.layouts.values()].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })); }
  saveLayout(value: LayoutInput): Layout {
    const saved: Layout = { ...clone(value), updatedAt: Math.floor(Date.now() / 1000) };
    this.layouts.set(saved.id, saved);
    const charts = new Set(saved.windows.filter((w) => w.kind === "chart").map((w) => w.id));
    for (const [id, drawing] of this.drawingValues) {
      if (drawing.scope.kind === "cell" && drawing.scope.layoutId === saved.id && !charts.has(drawing.scope.windowId)) this.drawingValues.set(id, { ...drawing, scope: { kind: "layout", layoutId: saved.id }, updatedAt: saved.updatedAt });
    }
    return clone(saved);
  }
  deleteLayout(id: string): boolean {
    if ([...this.drawingValues.values()].some((drawing) => drawing.scope.kind !== "symbol" && drawing.scope.layoutId === id)) return false;
    return this.layouts.delete(id);
  }
  watchlists(): Watchlists { return clone(this.watchlistValue); }
  saveWatchlists(value: { lists: readonly WatchlistSeed[]; revision: number }): Watchlists {
    this.watchlistValue = { revision: value.revision, lists: value.lists.map((l) => ({ ...clone(l), groups: clone(l.groups ?? []) })) };
    return this.watchlists();
  }
  heatmapThemes(): HeatmapThemes { return clone(this.heatmapThemeValue); }
  saveHeatmapThemes(value: HeatmapThemes): HeatmapThemes { this.heatmapThemeValue = clone(value); return this.heatmapThemes(); }
  screens(): Screens { return clone(this.screenValue); }
  saveScreens(value: Screens): Screens { this.screenValue = clone(value); return this.screens(); }
  uiPrefs() { return parseUiState(this.uiValue).prefs; }
  uiState(): UiState { return clone(this.uiValue); }
  saveUiState(value: UiState): UiState { this.uiValue = clone(value); return this.uiState(); }
  drawings(symbol: string): Drawing[] { return clone([...this.drawingValues.values()].filter(value => value.symbol === symbol).sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))); }
  saveDrawing(value: DrawingInput): Drawing {
    const saved: Drawing = { ...clone(value), updatedAt: Math.floor(Date.now() / 1000) };
    this.drawingValues.set(saved.id, saved);
    this.drawingRevisions.set(saved.id, saved.revision);
    return clone(saved);
  }
  hasScope(scope: DrawingInput["scope"]): boolean {
    if (scope.kind === "symbol") return true;
    const layout = this.layouts.get(scope.layoutId);
    return layout !== undefined && (scope.kind === "layout" || layout.windows.some((w) => w.kind === "chart" && w.id === scope.windowId));
  }
  deleteDrawing(id: string): void { this.drawingValues.delete(id); this.drawingRevisions.delete(id); }
  drawingRevision(id: string): number { return this.drawingRevisions.get(id) ?? -1; }
}

function fixtureSymbol(symbol: string) {
  const info = findSymbol(symbol);
  return info?.code === "086520" ? { ...info, years: 4.8 } : info;
}

export class MarketFixtures {
  constructor(readonly now: number) {}
  readonly symbols: SymbolInfo[] = [...SYMBOLS.map(publicInfo),
    { code: "000810", name: "삼성화재", kind: "common", market: "kospi", nxtEnabled: true },
    { code: "0000D0", name: "TIGER 엔비디아미국채커버드콜밸런스(합성)", kind: "etf", market: "kospi", nxtEnabled: false },
  ];
  page({ symbol, period = "D", venue, limit = 500, before = null }: { symbol: string; period?: Period; venue?: Venue | null; limit?: number; before?: number | null }): BarsPage {
    const info = fixtureSymbol(symbol) ?? { code: symbol, name: symbol, kind: "common", market: "kospi", nxtEnabled: false, close: 10000, volume: 100000, years: 5 } satisfies Parameters<typeof barsPage>[0];
    const resolved = resolveVenue(info, venue ?? null);
    if ("error" in resolved) throw new Error(resolved.error);
    return clone(barsPage(info, resolved.venue, period, before === null ? Math.max(1, limit - 1) : limit, before, this.now));
  }
  jumpPage({ symbol, period = "1m", venue, date, limit = 500, before = null }: { symbol: string; period?: Period; venue?: Venue | null; date: string; limit?: number; before?: number | null }): JumpBarsPage {
    const dayEnd = Date.parse(`${date}T00:00:00+09:00`) / 1000 + 86400;
    const page = this.page({ symbol, period, venue, limit, before: before ?? dayEnd });
    return { symbol: page.symbol, venue: page.venue, period: page.period, date, bars: page.bars, nextBefore: page.nextBefore, unadjustedDays: [] };
  }
  quote(symbol: string, venue: Venue = "combined") { const info = fixtureSymbol(symbol); return info ? quoteOf(info, this.now, venue) : null; }
  search(query: string, options: { market?: string | null; kind?: string | null } = {}): SymbolInfo[] {
    const extra = this.symbols.filter(value => query.length > 0 && !findSymbol(value.code) && (value.code === query || value.name.includes(query)));
    return [...search(query), ...extra].filter(value => (!options.market || value.market === options.market) && (!options.kind || value.kind === options.kind));
  }
}

export const DAY_SUMMARY_VOLUME = 1_234_567;

export const daySummaryOf = (quote: Quote): SymbolDaySummary => ({
  symbol: quote.symbol, venue: quote.venue ?? "combined", price: quote.price, previousClose: quote.price - quote.change, open: quote.price - 100, high: quote.price + 400, low: quote.price - 600,
  volume: DAY_SUMMARY_VOLUME, tradeValueWon: Math.round(quote.price * DAY_SUMMARY_VOLUME), t: quote.t,
});

export const CONNECTED_KIWOOM: KiwoomLinkStatus = {
  environment: "real", keySource: "file", appKeyTail: "1234", registeredIp: null, credentialId: null, state: "connected", problem: null, message: "키움에 연결되어 있습니다",
  retryAt: null, needsAcknowledgement: false, step: null, tokenExpiresAt: null, realtimeRegistered: 0, symbolCount: 2800, atStart: "connects",
};

export { KIWOOM_MARKET_SOURCE } from "./market-source";

export const ORDERS_OFF_MESSAGE = "주문 사용이 꺼져 있습니다";
export const KEY_LIMIT = 5;

export const NO_KIS_ACCOUNT: KisAccountListing = { accountTail: null, accountMasked: null, htsIdSet: false, source: "file" };

export const keyEntry = (keyId: string, alias: string, link: KiwoomLinkStatus, patch: Partial<KiwoomKey> = {}): KiwoomKey =>
  ({ keyId, alias, broker: "kiwoom", source: link.keySource === "env" ? "env" : "file", appKeyTail: link.appKeyTail, market: false, link, kisAccount: patch.broker === "kis" ? NO_KIS_ACCOUNT : null, ...patch });

export const keyListOf = (...keys: KiwoomKey[]): KiwoomKeyList => ({ limit: KEY_LIMIT, keys, keyFileProblem: null });

const keyListFromLink = (link: KiwoomLinkStatus): KiwoomKeyList =>
  keyListOf(...(link.keySource === "none" ? [] : [keyEntry(link.keySource === "env" ? "env" : "k1", link.keySource === "env" ? "환경 설정 키" : "키 1", link, { market: true })]));

export const SYNCED: SyncStatus = { state: "running", lastSuccessAt: 1_762_650_000, pendingDocuments: 0, refusedDocuments: 0, lastError: null };

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  environment: "real", bind: "127.0.0.1:8080", logFilter: "info", staticDir: "web/dist", dbPath: "data/vally.db", screenerDbPath: "data/screener.db", financialDbPath: "data/financial.db",
  hogaDataDir: "data/hoga", sharedDataDir: null,
  screenerUpdateOnStart: true, tokenPath: "state/kiwoom-token.json", keyPath: "state/kiwoom-key.json", lockPath: "state/vally.lock",
  kiwoomTarget: { kind: "kiwoom", host: "api.kiwoom.com" }, serverVersion: "0.1.0-test",
  accountServerUrl: null, accountStatePath: "state/account.json",
};

export class LiveFrames {
  readonly messages: ClientMessage[] = [];
  private observers = new Set<(frame: ServerMessage) => void>();
  observe(listener: (frame: ServerMessage) => void): () => void { this.observers.add(listener); return () => this.observers.delete(listener); }
  private send(socket: WebSocketRoute, frame: ServerMessage): void { for (const observer of this.observers) observer(frame); socket.send(JSON.stringify(frame)); }
  private peers = new Map<WebSocketRoute, Map<string, Subscription>>();
  private seq = 0;
  private state: ConnectionStatus;
  kiwoomLink: KiwoomLinkStatus = CONNECTED_KIWOOM;
  kiwoomKeys: KiwoomKeyList | null = null;
  marketSource: MarketSourceStatus = KIWOOM_MARKET_SOURCE;
  account: AccountStatus = { state: "local_only" };
  opened = 0;
  orders: OrdersStatus = { state: "off", accountRef: null, accountTail: null, message: ORDERS_OFF_MESSAGE, accounts: [{ keyId: "k1", broker: "kiwoom", alias: "키 1", market: true, state: "off", accountRef: null, accountTail: null }] };
  ordersAccountTail = "01";
  ordersAccountTails: Record<string, string> = {};
  ordersAccountRefs: Record<string, string> = {};
  kiwoomUsage: KiwoomUsage = { lastMinuteStartedAt: null, totalRateLimited: 0, trs: [] };
  constructor(private readonly now: number, private readonly market: MarketFixtures) { this.state = { realtime: "live", since: Math.floor(now / 1000), backfilling: false }; }
  connect(socket: WebSocketRoute) {
    const subscriptions = new Map<string, Subscription>();
    this.opened++;
    this.peers.set(socket, subscriptions);
    socket.send(JSON.stringify({ type: "hello", protocol: 1, serverTime: Math.floor(this.now / 1000), status: this.state } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: "vi_snapshot", states: [] } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: "kiwoom_link", status: this.kiwoomLink } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: "account", status: this.account } satisfies ServerMessage));
    socket.send(JSON.stringify({ type: "market_source", status: this.marketSource } satisfies ServerMessage));
    socket.onMessage(message => {
      const input: ClientMessage = JSON.parse(String(message));
      this.messages.push(input);
      if (input.type === "subscribe") {
        subscriptions.set(input.sub, input);
        socket.send(JSON.stringify({ type: "subscribed", sub: input.sub, seq: this.seq, current: null } satisfies ServerMessage));
      } else if (input.type === "unsubscribe") subscriptions.delete(input.sub);
    });
    socket.onClose(() => this.peers.delete(socket));
  }
  subscriptions(): Subscription[] { return clone([...this.peers.values()].flatMap(value => [...value.values()])); }
  emit(frame: ServerMessage): void { for (const socket of this.peers.keys()) this.send(socket, frame); }
  bar(symbol: string, bar: Bar, type: "bar" | "confirmed" = "bar"): number {
    let delivered = 0;
    for (const [socket, subscriptions] of this.peers) for (const subscription of subscriptions.values()) if (subscription.symbol === symbol) {
      this.send(socket, { type, sub: subscription.sub, seq: ++this.seq, bar });
      delivered++;
    }
    return delivered;
  }
  update(symbol: string, patch: Partial<Bar>): number {
    let delivered = 0;
    for (const [socket, subscriptions] of this.peers) for (const subscription of subscriptions.values()) if (subscription.symbol === symbol) {
      const fixture = this.market.page({ symbol, venue: subscription.venue, period: subscription.period }).current;
      if (!fixture) throw new Error(`Missing current bar fixture: ${symbol}/${subscription.period}`);
      this.send(socket, { type: "bar", sub: subscription.sub, seq: ++this.seq, bar: { ...fixture, ...patch } });
      delivered++;
    }
    return delivered;
  }
  link(status: KiwoomLinkStatus): void { this.kiwoomLink = clone(status); this.emit({ type: "kiwoom_link", status }); }
  source(status: MarketSourceStatus): void { this.marketSource = clone(status); this.emit({ type: "market_source", status }); }
  setAccount(status: AccountStatus): void { this.account = clone(status); this.emit({ type: "account", status }); }
  status(status: ConnectionStatus): void { this.state = clone(status); this.emit({ type: "status", status }); }
  close(code = 1000, reason = "fixture close"): void { for (const socket of this.peers.keys()) socket.close({ code, reason }); this.peers.clear(); }
}

export class Scenario {
  readonly documents = new UserDocuments();
  readonly market: MarketFixtures;
  readonly live: LiveFrames;
  readonly requests: Request[] = [];
  readonly publicMode = new PublicMode();
  kiwoomCatalog: KiwoomCatalog = EMPTY_KIWOOM_CATALOG;
  private handlers: Array<{ match: Matcher; handler: Handler }> = [];
  private failures: string[] = [];
  private contexts = new Set<BrowserContext>();
  private holds = new Set<() => void>();
  constructor(readonly now = Date.parse("2026-11-09T10:00:00+09:00")) { this.market = new MarketFixtures(now); this.live = new LiveFrames(now, this.market); }
  reply(match: Matcher, response: FixtureReply): void { this.on(match, () => clone(response)); }
  on(match: Matcher, handler: Handler): void { this.handlers.push({ match, handler }); }
  hold(match: Matcher) {
    let release: (reply: FixtureReply) => void = () => {};
    let received: (request: Request) => void = () => {};
    const request = new Promise<Request>(resolve => { received = resolve; });
    const pending = new Promise<FixtureReply>(resolve => { release = resolve; });
    const cleanup = () => release(error(503, "internal", "Test closed a held request"));
    this.holds.add(cleanup);
    this.on(match, input => { received(input); return pending; });
    return { received: request, reply: (response: FixtureReply) => { this.holds.delete(cleanup); release(response); } };
  }
  async install(context: BrowserContext): Promise<void> {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    context.on("request", request => { if (isScenarioPath(new URL(request.url()).pathname)) this.requests.push(request); });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== (process.env.VALLY_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.VALLY_E2E_PORT ?? "4173"}`)) {
        this.failures.push(`Unexpected network request: ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      }
      if (isScenarioPath(url.pathname)) return this.fulfill(route);
      await route.continue();
    });
    await context.routeWebSocket("**/*", socket => {
      const url = new URL(socket.url());
      if (url.pathname === "/api/ws" && url.host === new URL(process.env.VALLY_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.VALLY_E2E_PORT ?? "4173"}`).host) this.live.connect(socket);
      else { this.failures.push(`Unexpected WebSocket: ${url.origin}${url.pathname}`); socket.close({ code: 1008, reason: "Unexpected test network" }); }
    });
  }
  async fulfill(route: Route): Promise<void> {
    const reply = await this.respond(route.request());
    if (reply.status === 204) { await route.fulfill({ status: 204 }); return; }
    if (reply.body instanceof Uint8Array) {
      await route.fulfill({
        status: reply.status ?? 200,
        body: Buffer.from(reply.body),
        contentType: "application/octet-stream",
        headers: { date: new Date(this.now).toUTCString(), ...reply.headers },
      });
      return;
    }
    await route.fulfill({ status: reply.status ?? 200, json: reply.body ?? null, headers: { date: new Date(this.now).toUTCString(), ...reply.headers } });
  }
  async respond(request: Request): Promise<FixtureReply> {
    for (const { match, handler } of this.handlers.toReversed()) if (matches(match, request)) return handler(request);
    return this.baseline(request);
  }
  private baseline(request: Request): FixtureReply {
    const publicReply = this.publicMode.baseline(request);
    if (publicReply) return publicReply;
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const stale = () => error(409, "stale_revision", "더 새 편집이 이미 저장돼 있습니다");
    if (path === "/api/layouts" && method === "GET") return { body: this.documents.layoutSummaries() };
    if (path.startsWith("/api/layouts/")) {
      const id = decodeURIComponent(path.slice("/api/layouts/".length));
      if (method === "GET") return this.documents.layoutSummaries().some((layout) => layout.id === id) ? { body: this.documents.layout(id) } : error(404, "not_found", "레이아웃이 없습니다");
      if (method === "PUT") {
        const value: LayoutInput = request.postDataJSON();
        if ([...value.name.trim()].length < 1 || [...value.name.trim()].length > 20) return error(400, "bad_request", "레이아웃 이름은 1~20자여야 합니다");
        if (this.documents.layoutSummaries().some((layout) => layout.id !== id && layout.name === value.name.trim())) return error(409, "conflict", "같은 이름의 레이아웃이 있습니다");
        const stored = this.documents.layoutSummaries().some(value => value.id === id) ? this.documents.layout(id) : null;
        return stored && value.revision <= stored.revision ? stale() : { body: this.documents.saveLayout(value) };
      }
    }
    if (path.startsWith("/api/layouts/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/layouts/".length));
      return this.documents.deleteLayout(id) ? { body: null } : error(409, "conflict", "이 레이아웃 범위의 드로잉이 있어 지울 수 없습니다");
    }
    if (path === "/api/watchlists") {
      if (method === "GET") return { body: this.documents.watchlists() };
      if (method === "PUT") { const value: Watchlists = request.postDataJSON(); return value.revision <= this.documents.watchlists().revision ? stale() : { body: this.documents.saveWatchlists(value) }; }
    }
    if (path === "/api/heatmap/themes") {
      if (method === "GET") return { body: this.documents.heatmapThemes() };
      if (method === "PUT") { const value: HeatmapThemes = request.postDataJSON(); return value.revision <= this.documents.heatmapThemes().revision ? stale() : { body: this.documents.saveHeatmapThemes(value) }; }
    }
    if (path === "/api/heatmap/board" && method === "GET") {
      const venue = url.searchParams.get("venue") ?? "combined";
      const order = parseOrder(url.searchParams.get("order"));
      const source = parseSource(url.searchParams.get("source"));
      if ((venue !== "combined" && venue !== "krx" && venue !== "nxt") || order === null || source === null) return error(400, "bad_request", "Invalid venue, order or source");
      const memberOf = (code: string) => {
        const quote = this.market.quote(code, venue);
        const name = this.market.symbols.find((value) => value.code === code)?.name ?? code;
        return quote ? { symbol: code, name, changeRate: quote.changeRate, ...(quote.tradedMillionWon === undefined ? {} : { tradedMillionWon: quote.tradedMillionWon }) } : null;
      };
      return { body: source === "kiwoom" ? kiwoomBoardOf(this.kiwoomCatalog, memberOf, order, null) : boardOf(this.documents.heatmapThemes(), memberOf, order, null) };
    }
    if (path === "/api/screens") {
      if (method === "GET") return { body: this.documents.screens() };
      if (method === "PUT") { const value: Screens = request.postDataJSON(); return value.revision <= this.documents.screens().revision ? stale() : { body: this.documents.saveScreens(value) }; }
    }
    if (path === "/api/ui-state") {
      if (method === "GET") return { body: this.documents.uiState() };
      if (method === "PUT") { const value: UiState = request.postDataJSON(); return value.revision <= this.documents.uiState().revision ? stale() : { body: this.documents.saveUiState(value) }; }
    }
    if (path === "/api/drawings" && method === "GET") return { body: this.documents.drawings(url.searchParams.get("symbol") ?? "") };
    if (path.startsWith("/api/drawings/")) {
      const id = decodeURIComponent(path.slice("/api/drawings/".length));
      if (method === "DELETE") { this.documents.deleteDrawing(id); return { status: 204 }; }
      if (method === "PUT") {
        const value: DrawingInput = request.postDataJSON();
        if (value.revision <= this.documents.drawingRevision(id)) return stale();
        return this.documents.hasScope(value.scope) ? { body: this.documents.saveDrawing(value) } : error(400, "bad_request", "드로잉 범위의 레이아웃이나 차트 창이 없습니다");
      }
    }
    if (path === "/api/account" && method === "GET") return { body: this.live.account };
    if (path === "/api/collector/access" && method === "GET") return { body: { access: "off" } satisfies CollectorAccess };
    if (path === "/api/system/kiwoom" && method === "GET") return { body: this.live.kiwoomLink };
    if (path === "/api/system/kiwoom/keys" && method === "GET") return { body: this.live.kiwoomKeys ?? keyListFromLink(this.live.kiwoomLink) };
    if (path === "/api/system/market-source" && method === "GET") return { body: this.live.marketSource };
    if (path === "/api/system/kiwoom/usage" && method === "GET") return { body: this.live.kiwoomUsage };
    if (path === "/api/system/orders" && method === "GET") return this.ordersFor(url.searchParams.get("account"));
    if (path === "/api/system/orders/check-account" && method === "POST") {
      const keyId = url.searchParams.get("keyId") ?? "";
      const broker = this.live.orders.accounts.find((account) => account.keyId === keyId)?.broker ?? "kiwoom";
      return { body: { broker, accountTail: this.live.ordersAccountTails[keyId] ?? this.live.ordersAccountTail } satisfies OrdersAccountCheck };
    }
    if (path === "/api/system/orders" && method === "PUT") return this.switchOrders(request.postDataJSON());
    if (path === "/api/system/settings" && method === "GET") return { body: DEFAULT_SYSTEM_SETTINGS };
    if (path === "/api/symbols" && method === "GET") return { body: this.market.search(url.searchParams.get("q") ?? "", { market: url.searchParams.get("market"), kind: url.searchParams.get("kind") }) };
    if (path === "/api/quotes" && method === "GET") {
      const venue = url.searchParams.get("venue") ?? "combined";
      if (venue !== "combined" && venue !== "krx" && venue !== "nxt") return error(400, "bad_request", "Invalid venue");
      return { body: (url.searchParams.get("symbols") ?? "").split(",").flatMap(symbol => { const quote = this.market.quote(symbol, venue); return quote ? [quote] : []; }) };
    }
    const daySummary = /^\/api\/symbols\/([^/]+)\/day-summary$/.exec(path);
    if (daySummary && method === "GET") {
      const symbol = decodeURIComponent(daySummary[1]!);
      const venue = url.searchParams.get("venue") ?? "combined";
      if (venue !== "combined" && venue !== "krx" && venue !== "nxt") return error(400, "bad_request", "Invalid venue");
      if (symbol.startsWith("IDX:")) return error(400, "bad_request", "지수에는 종목 당일 요약이 없습니다");
      const quote = this.market.quote(symbol, venue);
      return { body: quote ? daySummaryOf(quote) : { symbol, venue, price: null, previousClose: null, open: null, high: null, low: null, volume: null, tradeValueWon: null, t: null } satisfies SymbolDaySummary };
    }
    if (path === "/api/bars" && method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const period = url.searchParams.get("period") ?? "D";
      const venue = url.searchParams.get("venue");
      if (!isPeriod(period)) return error(400, "bad_request", "Invalid period");
      if (venue !== null && venue !== "combined" && venue !== "krx" && venue !== "nxt") return error(400, "bad_request", "Invalid venue");
      const value = findSymbol(symbol);
      if (symbol === "999999" || value?.fail === "unknown_symbol") return error(404, "unknown_symbol", `종목 ${symbol}을 찾을 수 없습니다`);
      if (value?.fail === "kiwoom_unavailable") return error(503, "kiwoom_unavailable", "조회가 응답하지 않습니다");
      return { body: this.market.page({ symbol, period, venue, limit: Number(url.searchParams.get("limit") ?? 500), before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null }) };
    }
    if (path === "/api/bars/jump" && method === "GET") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const period = url.searchParams.get("period") ?? "";
      const venue = url.searchParams.get("venue");
      const date = url.searchParams.get("date") ?? "";
      if (!isPeriod(period) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return error(400, "bad_request", "Invalid period or date");
      if (venue !== null && venue !== "combined" && venue !== "krx" && venue !== "nxt") return error(400, "bad_request", "Invalid venue");
      return { body: this.market.jumpPage({ symbol, period, venue, date, limit: Number(url.searchParams.get("limit") ?? 500), before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null }) };
    }
    if (/^\/api\/symbols\/[^/]+$/.test(path) && method === "GET") { const value = this.market.symbols.find(value => value.code === decodeURIComponent(path.slice("/api/symbols/".length))); return value ? { body: value } : error(404, "unknown_symbol", "종목이 없습니다"); }
    const etf = etfBaseline(path, method, url.searchParams);
    if (etf) return etf;
    const marketOverview = marketOverviewBaseline(url, method);
    if (marketOverview) return marketOverview;
    if (path === "/api/rankings" && method === "POST") return { body: { rows: [], pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(this.now / 1000), source: "kiwoom" } satisfies RankingPage };
    if (path === "/api/screener/status" && method === "GET") return { body: { lastDay: null, needDay: "2026-11-06", todayAvailable: false, fullHistory: { done: 0, total: 0 }, unconfirmed: 0, update: null } satisfies ScreenerStatus };
    if (/\/financials$/.test(path) && method === "GET") return { body: { symbol: decodeURIComponent(path.split("/")[3] ?? ""), period: url.searchParams.get("period") === "Q" ? "Q" : "Y", status: "not_collected", reason: null, failure: null, corpCode: null, fiscalMonth: null, shareClass: null, shareClassReason: null, lastCheckedAt: null, lastAttemptAt: null, disclosureFailure: null, refreshVersion: 0, disclosureVersion: 0, latestCorrections: false, progress: { total: 0, completed: 0, failed: 0, pending: 0 }, series: [] } satisfies FinancialsPage };
    if (/^\/api\/symbols\/[^/]+\/quote-totals$/.test(path) && method === "GET") {
      const venue = url.searchParams.get("venue") ?? "combined";
      if (venue !== "combined" && venue !== "krx" && venue !== "nxt") return error(400, "bad_request", "Invalid venue");
      return { body: { available: true, venue, days: [], points: [] } satisfies QuoteTotalsPage };
    }
    const description = `Unconfigured API fixture: ${method} ${url.pathname}${url.search}`;
    this.failures.push(description);
    return error(599, "internal", description);
  }
  private ordersTopOf(row: OrdersAccount): OrdersStatus {
    const message = row.state === "on" ? "주문 사용이 켜져 있습니다" : ORDERS_OFF_MESSAGE;
    return { state: row.state, accountRef: row.accountRef, accountTail: row.accountTail, message, accounts: this.live.orders.accounts };
  }
  private ordersFor(account: string | null): FixtureReply {
    if (account === null) return { body: this.live.orders };
    const row = this.live.orders.accounts.find((candidate) => candidate.accountRef === account);
    return row ? { body: this.ordersTopOf(row) } : error(404, "not_found", "알 수 없는 계좌입니다");
  }
  private switchOrders(input: OrdersSwitchInput): FixtureReply {
    const accounts = this.live.orders.accounts;
    const row = accounts.find((candidate) => (input.keyId === undefined ? candidate.market : candidate.keyId === input.keyId));
    if (!row) return error(404, "not_found", "알 수 없는 키입니다");
    if (!input.enabled) row.state = "off";
    else {
      const tail = this.live.ordersAccountTails[row.keyId] ?? this.live.ordersAccountTail;
      if (input.confirmAccountTail !== tail) return error(400, "bad_request", "확인한 계좌 끝 2자리가 계좌와 다릅니다");
      const ref = this.live.ordersAccountRefs[row.keyId] ?? (row.market ? "synthetic-account" : `ref-${row.keyId}`);
      const twin = accounts.find((candidate) => candidate.keyId !== row.keyId && candidate.state === "on" && candidate.accountRef === ref);
      if (twin) return error(409, "conflict", `‘${twin.alias}’와 같은 계좌입니다. 주문은 한 줄에서만 씁니다`);
      Object.assign(row, { state: "on", accountRef: ref, accountTail: tail });
    }
    const top = this.ordersTopOf(row);
    if (row.market) this.live.orders = top;
    return { body: top };
  }
  async close(): Promise<void> { for (const release of this.holds) release(); this.holds.clear(); this.live.close(); if (this.failures.length) throw new Error(this.failures.join("\n")); }
}
