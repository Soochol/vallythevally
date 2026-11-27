import type { SymbolDaySummary } from "../../api/generated/SymbolDaySummary";
import type { ExecutionForensics } from "../../api/generated/ExecutionForensics";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { OrderCommand } from "../../api/generated/OrderCommand";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";
import type { SystemSettings } from "../../api/generated/SystemSettings";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOpenOrder } from "../../api/generated/TradingOpenOrder";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import type { ViPlaybook } from "../../api/generated/ViPlaybook";
import { DEFAULT_CHART_SETTINGS } from "../../chart/settings";
import { windowId } from "../../layout/kinds";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useLayoutStore } from "../../stores/layout";
import { marketSocket, viExpectedStore } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { DEFAULT_UI_PREFS } from "../../persist/uiState";
import { useUiStore } from "../../stores/ui";
import { installMockWebSocket, stubFetch, type MockSocketController } from "../../test/domHarness";
import { DEFAULT_ORDER_SETTINGS } from "./orderSettings";
import { pendingWrites } from "./pendingWrites";

export const ACCOUNT = "ref-k1";
export const CODE = "005930";
export const BASE = 70_000;
export const SETTINGS_CHART = DEFAULT_CHART_SETTINGS;

export const ORDER_BOOK: OrderBook = {
  symbol: CODE,
  asks: [
    { price: BASE + 100, quantity: 500 },
    { price: BASE + 200, quantity: 400 },
    { price: BASE + 300, quantity: 300 },
  ],
  bids: [
    { price: BASE, quantity: 600 },
    { price: BASE - 100, quantity: 500 },
    { price: BASE - 200, quantity: 400 },
  ],
  totalAskQuantity: 1200,
  totalBidQuantity: 1500,
  afterHoursAskQuantity: null,
  afterHoursBidQuantity: null,
  bookTime: "10:00:00",
  expected: null,
};

export const connectedKiwoom = (env: "real" | "mock" = "real"): KiwoomLinkStatus => ({
  environment: env,
  keySource: "file",
  appKeyTail: "7Z2D",
  credentialId: "k1",
  state: "connected",
  problem: null,
  message: "연결됨",
  retryAt: null,
  needsAcknowledgement: false,
  step: "realtime",
  tokenExpiresAt: 1_800_000_000,
  realtimeRegistered: 1,
  symbolCount: 2500,
  registeredIp: null,
  atStart: null,
});

export const defaultOrdersStatus = (accounts?: OrdersAccount[]): OrdersStatus => ({
  state: "on",
  accountRef: ACCOUNT,
  accountTail: "12",
  message: "주문 사용이 켜져 있습니다",
  accounts: accounts ?? [
    { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: ACCOUNT, accountTail: "12" },
  ],
});

export const openOrder = (orderNo: string, side: "buy" | "sell", price: number, quantity: number, code = CODE, name = "삼성전자"): TradingOpenOrder => ({
  orderNo,
  code,
  name,
  side,
  price,
  quantity,
  openQuantity: quantity,
  status: "accepted",
  orderedAt: "093000",
  originalOrderNo: null,
  venue: "krx",
});

export interface OrderTestEnv {
  readonly socket: MockSocketController;
  readonly api: ReturnType<typeof stubFetch>;
  holdings: TradingHolding[];
  creditHoldings: TradingHolding[];
  openOrders: TradingOpenOrder[];
  executions: TradingExecution[];
  orderable: Partial<TradingOrderable>;
  policy: MarginPolicy;
  policyFailMessage: string | null;
  buyableFailMessage: string | null;
  placeReply: Partial<OrderCommand> | null;
  forensics: ExecutionForensics | null;
  playbook: ViPlaybook | null;
  daySummaryOpen: number | null;
  blocked: boolean;
  accountNumberText: string | null;
  customBalanceHandler: (() => Promise<Response | { status?: number; body?: unknown }> | { status?: number; body?: unknown }) | null;
  balanceCalls: () => number;
  forensicsCalls: () => number;
  daySummaryCalls: (venue?: string) => number;
  placedBodies: () => Record<string, unknown>[];
  policyWrites: () => { policy: MarginPolicy; account?: string }[];
}

export function resetOrderStores(envType: "real" | "mock" = "real", accounts?: OrdersAccount[]) {
  pendingWrites.clear();
  viExpectedStore.clear();
  const link = connectedKiwoom(envType);
  const source: MarketSourceStatus = {
    broker: "kiwoom",
    keyId: "k1",
    alias: "주계좌",
    state: "connected",
    problem: null,
    step: "realtime",
    retryAt: null,
    features: ["quotes", "orderBook"],
    feedBroker: { broker: "kiwoom", rankingKinds: ["tradeAmount", "expected"], rankingChoices: [], overviewFeatures: [] },
  };
  useKiwoomLinkStore.setState({ kiwoom: link, status: link, source, pushes: 0, sourcePushes: 0 });
  useSelectionStore.setState({ dialog: null, activeCell: windowId("cell-0"), toasts: [], toast: null });
  useUiStore.setState({
    prefs: {
      ...DEFAULT_UI_PREFS,
      orderSettings: { ...DEFAULT_ORDER_SETTINGS },
      orderEntries: {},
    },
  });
  useLayoutStore.setState((s) => ({
    ...s,
    layout: {
      ...s.layout,
      windows: [
        { id: windowId("cell-0"), link: "a", kind: "chart", symbol: CODE, venue: "combined", period: "D", chartSettings: SETTINGS_CHART },
        { id: windowId("order"), link: "a", kind: "order", venue: "krx" },
      ],
    },
  }));
  void accounts;
}

export function setupOrderEnv(opts: {
  environment?: "real" | "mock";
  ordersStatus?: OrdersStatus;
  holdings?: TradingHolding[];
  creditHoldings?: TradingHolding[];
  openOrders?: TradingOpenOrder[];
  executions?: TradingExecution[];
  policy?: MarginPolicy;
  orderable?: Partial<TradingOrderable>;
  forensics?: ExecutionForensics | null;
  playbook?: ViPlaybook | null;
  nxtEnabled?: boolean;
  quotePrice?: number;
} = {}): OrderTestEnv {
  resetOrderStores(opts.environment ?? "real", opts.ordersStatus?.accounts);
  const ordersStatus = opts.ordersStatus ?? defaultOrdersStatus();
  const placed: Record<string, unknown>[] = [];
  const policies: { policy: MarginPolicy; account?: string }[] = [];
  let seq = 1;

  const state: Omit<OrderTestEnv, "socket" | "api" | "balanceCalls" | "forensicsCalls" | "daySummaryCalls" | "placedBodies" | "policyWrites"> = {
    holdings: opts.holdings ?? [],
    creditHoldings: opts.creditHoldings ?? [],
    openOrders: opts.openOrders ?? [],
    executions: opts.executions ?? [],
    orderable: opts.orderable ?? {},
    policy: opts.policy ?? "cash_only",
    policyFailMessage: null,
    buyableFailMessage: null,
    placeReply: null,
    forensics: opts.forensics ?? null,
    playbook: opts.playbook ?? null,
    daySummaryOpen: 69_900,
    blocked: false,
    accountNumberText: "12345678",
    customBalanceHandler: null,
  };

  const keys: KiwoomKeyList = {
    keys: [],
    limit: 5,
    keyFileProblem: null,
  };

  const sysSettings: SystemSettings = {
    environment: "real",
    bind: "127.0.0.1:8080",
    logFilter: "info",
    kiwoomTarget: { kind: "kiwoom", host: null },
    screenerUpdateOnStart: true,
    dbPath: "",
    screenerDbPath: "",
    financialDbPath: "",
    hogaDataDir: null,
    sharedDataDir: null,
    tokenPath: "",
    keyPath: "",
    lockPath: "",
    staticDir: "",
    serverVersion: "0.0.0",
    accountServerUrl: null,
    accountStatePath: null,
  };

  const api = stubFetch(({ method, pathname, url, json }) => {
    if (pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (pathname === "/api/system/settings") return { body: sysSettings };
    if (pathname === "/api/system/kiwoom/keys") return { body: keys };
    if (pathname === "/api/system/orders") return { body: ordersStatus };
    if (pathname === "/api/system/orders/margin" && method === "PUT") {
      if (state.policyFailMessage) {
        return { status: 400, body: { error: { code: "bad_request", message: state.policyFailMessage, reason: null, retryAt: null, manualActionRequired: false } } };
      }
      const req = json() as { policy: MarginPolicy; account?: string };
      policies.push(req);
      state.policy = req.policy;
      return { body: { accountRef: req.account ?? ACCOUNT, policy: state.policy } };
    }
    if (pathname === "/api/trading/account-number") {
      if (state.accountNumberText === null) {
        return { status: 500, body: { error: { code: "internal", message: "계좌번호 조회 실패", reason: null, retryAt: null, manualActionRequired: false } } };
      }
      return { body: { accountRef: ACCOUNT, accountNumber: state.accountNumberText } };
    }
    if (pathname === "/api/trading/balance") {
      if (state.customBalanceHandler) return state.customBalanceHandler();
      return { body: { accountRef: ACCOUNT, holdings: state.holdings, creditHoldings: state.creditHoldings, totalPurchase: 0, totalEvaluation: 0, totalProfit: 0 } satisfies TradingBalance };
    }
    if (pathname === "/api/trading/open-orders") return { body: { accountRef: ACCOUNT, orders: state.openOrders } };
    if (pathname === "/api/trading/executions") return { body: { accountRef: ACCOUNT, executions: state.executions } };
    if (pathname === "/api/trading/executions/forensics") {
      return { body: state.forensics ?? { date: "20261109", account: ACCOUNT, items: [] } };
    }
    if (pathname === "/api/trading/commands" && method === "GET") return { body: { accountRef: ACCOUNT, blocked: state.blocked, commands: [] } };
    if (pathname === "/api/trading/commands/place" && method === "POST") {
      const req = json() as Record<string, unknown>;
      placed.push(req);
      const reply: OrderCommand = {
        commandId: `cmd-${seq++}`,
        accountRef: ACCOUNT,
        kind: (req.side as "buy" | "sell") ?? "buy",
        code: String(req.code ?? CODE),
        venue: (req.venue as OrderCommand["venue"]) ?? "krx",
        quantity: Number(req.quantity ?? 10),
        price: Number(req.price ?? BASE),
        targetOrderNo: null,
        state: "accepted",
        reason: null,
        orderNo: `ord-${seq}`,
        reconciled: false,
        createdAt: 1_794_186_000,
        updatedAt: 1_794_186_000,
        ...state.placeReply,
      };
      return { body: reply };
    }
    if (pathname === "/api/trading/commands/cancel" && method === "POST") {
      const req = json() as { targetOrderNo: string };
      return {
        body: {
          commandId: `cmd-${seq++}`,
          accountRef: ACCOUNT,
          kind: "cancel",
          code: CODE,
          venue: "krx",
          quantity: 1,
          price: BASE,
          targetOrderNo: req.targetOrderNo,
          state: "accepted",
          reason: null,
          orderNo: null,
          reconciled: false,
          createdAt: 1_794_186_000,
          updatedAt: 1_794_186_000,
        } satisfies OrderCommand,
      };
    }
    if (pathname === "/api/trading/orderable") {
      if (state.buyableFailMessage) {
        return { status: 503, body: { error: { code: "internal", message: state.buyableFailMessage, reason: null, retryAt: null, manualActionRequired: false } } };
      }
      const price = Number(url.searchParams.get("price") ?? BASE);
      const cashAmount = state.orderable.cashAmount ?? 500_000_000;
      const marginAmount = state.orderable.marginAmount === undefined ? 1_500_000_000 : state.orderable.marginAmount;
      const body: TradingOrderable = {
        accountRef: ACCOUNT,
        code: url.searchParams.get("code") ?? CODE,
        side: "buy",
        price,
        amount: state.policy === "allow_margin" && marginAmount !== null ? marginAmount : cashAmount,
        quantity: Math.floor((state.policy === "allow_margin" && marginAmount !== null ? marginAmount : cashAmount) / Math.max(1, price)),
        policy: state.policy,
        cashAmount,
        cashQuantity: Math.floor(cashAmount / Math.max(1, price)),
        marginAmount,
        marginQuantity: marginAmount === null ? null : Math.floor(marginAmount / Math.max(1, price)),
        deposit: 520_000_000,
        unpaid: 0,
        stockRate: 100,
        accountRate: 40,
        appliedRate: 100,
        ...state.orderable,
      };
      return { body };
    }
    if (pathname.endsWith("/order-book")) return { body: ORDER_BOOK };
    if (pathname.endsWith("/trades")) return { body: { symbol: CODE, venue: "combined", trades: [], skippedRows: 0 } };
    if (pathname.endsWith("/day-summary")) {
      const price = opts.quotePrice ?? BASE;
      const summary: SymbolDaySummary = {
        symbol: CODE,
        venue: (url.searchParams.get("venue") as SymbolDaySummary["venue"]) ?? "combined",
        price,
        open: state.daySummaryOpen ?? price,
        high: price + 500,
        low: price - 500,
        volume: 1_230_000,
        tradeValueWon: 86_000_000_000,
        previousClose: BASE,
        t: 1_794_186_000,
      };
      return { body: summary };
    }
    if (pathname === `/api/symbols/${CODE}`) {
      return { body: { code: CODE, name: "삼성전자", kind: "stock", market: "kospi", nxtEnabled: opts.nxtEnabled ?? true } };
    }
    if (pathname === `/api/symbols/${CODE}/vi-playbook`) {
      return state.playbook ? { body: state.playbook } : { status: 404, body: { error: { code: "not_found", message: "없음", reason: null, retryAt: null, manualActionRequired: false } } };
    }
    if (pathname === "/api/quotes") return { body: [] };
    return { body: {} };
  });

  const socket = installMockWebSocket(marketSocket);

  return Object.assign(state, {
    socket,
    api,
    balanceCalls: () => api.callsTo("GET", "/api/trading/balance").length,
    forensicsCalls: () => api.callsTo("GET", "/api/trading/executions/forensics").length,
    daySummaryCalls: (venue?: string) =>
      api.calls.filter((c) => c.pathname.endsWith("/day-summary") && (venue === undefined || c.url.searchParams.get("venue") === venue)).length,
    placedBodies: () => placed,
    policyWrites: () => policies,
  });
}
