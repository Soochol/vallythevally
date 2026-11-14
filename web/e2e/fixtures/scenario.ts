import type { ApiError } from "../../src/api/generated/ApiError";
import { isPeriod } from "../../src/lib/symbol";
import { parseUiState } from "../../src/persist/uiState";
import type { BrowserContext, Request, Route, WebSocketRoute } from "@playwright/test";
import type { Bar } from "../../src/api/generated/Bar";
import type { BarsPage } from "../../src/api/generated/BarsPage";
import type { ClientMessage } from "../../src/api/generated/ClientMessage";
import type { ConnectionStatus } from "../../src/api/generated/ConnectionStatus";
import type { FinancialsPage } from "../../src/api/generated/FinancialsPage";
import type { FinancialUpdatePage } from "../../src/api/generated/FinancialUpdatePage";
import type { ScreenerStatus } from "../../src/api/generated/ScreenerStatus";
import type { Drawing } from "../../src/api/generated/Drawing";
import type { DrawingInput } from "../../src/api/generated/DrawingInput";
import type { Layout } from "../../src/api/generated/Layout";
import type { LayoutInput } from "../../src/api/generated/LayoutInput";
import type { LayoutWindow } from "../../src/api/generated/LayoutWindow";
import type { Period } from "../../src/api/generated/Period";
import type { Screens } from "../../src/api/generated/Screens";
import type { ServerMessage } from "../../src/api/generated/ServerMessage";
import type { SymbolInfo } from "../../src/api/generated/SymbolInfo";
import type { UiState } from "../../src/api/generated/UiState";
import type { Venue } from "../../src/api/generated/Venue";
import type { Watchlist } from "../../src/api/generated/Watchlist";
import type { Watchlists } from "../../src/api/generated/Watchlists";
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
const matches = (match: Matcher, request: Request) => typeof match === "string" ? new URL(request.url()).pathname === match : match(new URL(request.url()), request);

export class UserDocuments {
  private layouts = new Map<string, Layout>([[DEFAULT_LAYOUT_ID, { id: DEFAULT_LAYOUT_ID, name: "기본", sync: { crosshair: true, scroll: true }, windows: [{ id: "cell-0", link: null, kind: "chart", symbol: "IDX:001", venue: null, period: "D", chartSettings: { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } }, { id: "watchlist", link: null, kind: "watchlist" }, { id: "screener", link: null, kind: "screener" }, { id: "objects", link: null, kind: "objects" }], placement: {}, updatedAt: 0, revision: 0 }]]);
  private watchlistValue: Watchlists = { lists: [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: [], groups: [] }], revision: 0 };
  private screenValue: Screens = { screens: [], revision: 0 };
  private uiValue: UiState = { lastLayoutId: DEFAULT_LAYOUT_ID, theme: "dark", revision: 0 };
  private drawingValues = new Map<string, Drawing>();
  private drawingRevisions = new Map<string, number>();

  layout(id = DEFAULT_LAYOUT_ID): Layout {
    const value = this.layouts.get(id);
    if (!value) throw new Error(`Missing layout fixture: ${id}`);
    return clone(value);
  }
  layoutSummaries() { return [...this.layouts.values()].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })); }
  saveLayout(value: LayoutInput): Layout {
    const saved: Layout = { ...clone(value), updatedAt: Math.floor(Date.now() / 1000) };
    this.layouts.set(saved.id, saved);
    return clone(saved);
  }
  watchlists(): Watchlists { return clone(this.watchlistValue); }
  saveWatchlists(value: { lists: readonly WatchlistSeed[]; revision: number }): Watchlists {
    this.watchlistValue = { revision: value.revision, lists: value.lists.map((l) => ({ ...clone(l), groups: clone(l.groups ?? []) })) };
    return this.watchlists();
  }
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
  deleteDrawing(id: string): void { this.drawingValues.delete(id); this.drawingRevisions.delete(id); }
  drawingRevision(id: string): number { return this.drawingRevisions.get(id) ?? -1; }
}

export class MarketFixtures {
  constructor(readonly now: number) {}
  readonly symbols: SymbolInfo[] = [...SYMBOLS.map(publicInfo),
    { code: "000810", name: "삼성화재", kind: "common", market: "kospi", nxtEnabled: true },
    { code: "0000D0", name: "TIGER 엔비디아미국채커버드콜밸런스(합성)", kind: "etf", market: "kospi", nxtEnabled: false },
  ];
  page({ symbol, period = "D", venue, limit = 500, before = null }: { symbol: string; period?: Period; venue?: Venue | null; limit?: number; before?: number | null }): BarsPage {
    const info = findSymbol(symbol) ?? { code: symbol, name: symbol, kind: "common", market: "kospi", nxtEnabled: false, close: 10000, volume: 100000, years: 5 } satisfies Parameters<typeof barsPage>[0];
    const resolved = resolveVenue(info, venue ?? null);
    if ("error" in resolved) throw new Error(resolved.error);
    return clone(barsPage(info.code === "086520" ? { ...info, years: 4.8 } : info, resolved.venue, period, before === null ? Math.max(1, limit - 1) : limit, before, this.now));
  }
  quote(symbol: string) { const info = findSymbol(symbol); return info ? quoteOf(info, this.now) : null; }
  search(query: string, options: { market?: string | null; kind?: string | null } = {}): SymbolInfo[] {
    const extra = this.symbols.filter(value => query.length > 0 && !findSymbol(value.code) && (value.code === query || value.name.includes(query)));
    return [...search(query), ...extra].filter(value => (!options.market || value.market === options.market) && (!options.kind || value.kind === options.kind));
  }
}

export class LiveFrames {
  readonly messages: ClientMessage[] = [];
  private observers = new Set<(frame: ServerMessage) => void>();
  observe(listener: (frame: ServerMessage) => void): () => void { this.observers.add(listener); return () => this.observers.delete(listener); }
  private send(socket: WebSocketRoute, frame: ServerMessage): void { for (const observer of this.observers) observer(frame); socket.send(JSON.stringify(frame)); }
  private peers = new Map<WebSocketRoute, Map<string, Subscription>>();
  private seq = 0;
  private state: ConnectionStatus;
  constructor(private readonly now: number, private readonly market: MarketFixtures) { this.state = { realtime: "live", since: Math.floor(now / 1000), backfilling: false }; }
  connect(socket: WebSocketRoute) {
    const subscriptions = new Map<string, Subscription>();
    this.peers.set(socket, subscriptions);
    socket.send(JSON.stringify({ type: "hello", protocol: 1, serverTime: Math.floor(this.now / 1000), status: this.state } satisfies ServerMessage));
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
  status(status: ConnectionStatus): void { this.state = clone(status); this.emit({ type: "status", status }); }
  close(code = 1000, reason = "fixture close"): void { for (const socket of this.peers.keys()) socket.close({ code, reason }); this.peers.clear(); }
}

export class Scenario {
  readonly documents = new UserDocuments();
  readonly market: MarketFixtures;
  readonly live: LiveFrames;
  readonly requests: Request[] = [];
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
    context.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) this.requests.push(request); });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== (process.env.VALLY_E2E_BASE_URL ?? `http://127.0.0.1:${process.env.VALLY_E2E_PORT ?? "4173"}`)) {
        this.failures.push(`Unexpected network request: ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      }
      if (url.pathname.startsWith("/api/")) return this.fulfill(route);
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
    await route.fulfill({ status: reply.status ?? 200, json: reply.body ?? null, headers: { date: new Date(this.now).toUTCString(), ...reply.headers } });
  }
  async respond(request: Request): Promise<FixtureReply> {
    for (const { match, handler } of this.handlers.toReversed()) if (matches(match, request)) return handler(request);
    return this.baseline(request);
  }
  private baseline(request: Request): FixtureReply {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const stale = () => error(409, "stale_revision", "더 새 편집이 이미 저장돼 있습니다");
    if (path === "/api/layouts" && method === "GET") return { body: this.documents.layoutSummaries() };
    if (path.startsWith("/api/layouts/")) {
      const id = decodeURIComponent(path.slice("/api/layouts/".length));
      if (method === "GET") return { body: this.documents.layout(id) };
      if (method === "PUT") {
        const value: LayoutInput = request.postDataJSON();
        const stored = this.documents.layoutSummaries().some(value => value.id === id) ? this.documents.layout(id) : null;
        return stored && value.revision <= stored.revision ? stale() : { body: this.documents.saveLayout(value) };
      }
    }
    if (path === "/api/watchlists") {
      if (method === "GET") return { body: this.documents.watchlists() };
      if (method === "PUT") { const value: Watchlists = request.postDataJSON(); return value.revision <= this.documents.watchlists().revision ? stale() : { body: this.documents.saveWatchlists(value) }; }
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
        return value.revision <= this.documents.drawingRevision(id) ? stale() : { body: this.documents.saveDrawing(value) };
      }
    }
    if (path === "/api/symbols" && method === "GET") return { body: this.market.search(url.searchParams.get("q") ?? "", { market: url.searchParams.get("market"), kind: url.searchParams.get("kind") }) };
    if (path === "/api/quotes" && method === "GET") return { body: (url.searchParams.get("symbols") ?? "").split(",").flatMap(symbol => { const quote = this.market.quote(symbol); return quote ? [quote] : []; }) };
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
    if (/^\/api\/symbols\/[^/]+$/.test(path) && method === "GET") { const value = this.market.symbols.find(value => value.code === decodeURIComponent(path.slice("/api/symbols/".length))); return value ? { body: value } : error(404, "unknown_symbol", "종목이 없습니다"); }
    if (path === "/api/screener/status" && method === "GET") return { body: { lastDay: null, needDay: "2026-11-06", todayAvailable: false, fullHistory: { done: 0, total: 0 }, unconfirmed: 0, update: null } satisfies ScreenerStatus };
    if (path === "/api/financial-update" && method === "GET") return { body: { id: 0, status: "not_configured", phase: "planning", stopReason: null, nextCheckAt: null, canResume: false, automatic: false, latestCheckPending: false, historyCompletedCompanies: 0, historyFailedCompanies: 0, recentFailedCompanies: 0, historyComplete: false, fromYear: 2015, throughYear: 2026, totalSymbols: 0, processedSymbols: 0, unsupportedSymbols: 0, unverifiedSymbols: 0, unverifiedDividends: 0, totalCompanies: 0, completedCompanies: 0, failedCompanies: 0, startedAt: null, lastCheckedAt: null, failure: null, failures: [] } satisfies FinancialUpdatePage };
    if (/\/financials$/.test(path) && method === "GET") return { body: { symbol: decodeURIComponent(path.split("/")[3] ?? ""), period: url.searchParams.get("period") === "Q" ? "Q" : "Y", status: "not_collected", reason: null, failure: null, corpCode: null, fiscalMonth: null, shareClass: null, shareClassReason: null, lastCheckedAt: null, lastAttemptAt: null, disclosureFailure: null, refreshVersion: 0, disclosureVersion: 0, latestCorrections: false, progress: { total: 0, completed: 0, failed: 0, pending: 0 }, series: [] } satisfies FinancialsPage };
    const description = `Unconfigured API fixture: ${method} ${url.pathname}${url.search}`;
    this.failures.push(description);
    return error(599, "internal", description);
  }
  async close(): Promise<void> { for (const release of this.holds) release(); this.holds.clear(); this.live.close(); if (this.failures.length) throw new Error(this.failures.join("\n")); }
}
