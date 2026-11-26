// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Broker } from "../../api/generated/Broker";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { KiwoomUsage } from "../../api/generated/KiwoomUsage";
import type { KiwoomUsageTr } from "../../api/generated/KiwoomUsageTr";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";
import type { SystemSettings } from "../../api/generated/SystemSettings";
import { receiveKiwoomLinkPush, useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { ConfirmHost } from "../overlay/Confirm";
import { SystemSettingsDialog } from "./SystemSettingsDialog";

const FAKE_KEY = "FAKEAPPKEYabcdefgh7Z2D";
const FAKE_SECRET = "FAKESECRETvalue0123456789xyz";
const BLOCKED_MSG = "키움이 지정단말기 인증을 거절했습니다(8050). 고친 뒤 아래에서 다시 연결하세요. 서버를 다시 켤 필요는 없습니다";

const CONNECTED: KiwoomLinkStatus = {
  environment: "real",
  keySource: "file",
  appKeyTail: "7Z2D",
  credentialId: "k1",
  registeredIp: null,
  atStart: null,
  state: "connected",
  step: "realtime",
  problem: null,
  retryAt: null,
  needsAcknowledgement: false,
  message: "연결됨",
  tokenExpiresAt: Math.floor(Date.parse("2026-11-18T18:00:00+09:00") / 1000),
  realtimeRegistered: 12,
  symbolCount: 2500,
};

const NO_KEY: KiwoomLinkStatus = {
  ...CONNECTED,
  keySource: "none",
  appKeyTail: null,
  state: "noKey",
  step: null,
  message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다",
  realtimeRegistered: null,
  symbolCount: null,
};

const DISCONNECTED: KiwoomLinkStatus = {
  ...NO_KEY,
  keySource: "file",
  appKeyTail: "7Z2D",
  state: "disconnected",
  message: "키가 저장돼 있습니다. 연결하지 않았습니다",
};

const failed = (problem: NonNullable<KiwoomLinkStatus["problem"]>, retryAt: number | null, message: string, patch: Partial<KiwoomLinkStatus> = {}): KiwoomLinkStatus =>
  ({ ...DISCONNECTED, state: "failed", problem, retryAt, message, ...patch });

const keyEntry = (keyId: string, alias: string, link: KiwoomLinkStatus, opts: { market?: boolean; broker?: Broker; source?: "file" | "env"; kisAccountTail?: string | null; kisHtsIdSet?: boolean } = {}): KiwoomKey => ({
  keyId,
  broker: opts.broker ?? "kiwoom",
  alias,
  market: opts.market ?? false,
  source: opts.source ?? (link.keySource === "env" ? "env" : "file"),
  appKeyTail: link.appKeyTail,
  link,
  kisAccount: opts.broker === "kis"
    ? {
        accountTail: opts.kisAccountTail === undefined ? "88" : opts.kisAccountTail,
        accountMasked: opts.kisAccountTail === null ? null : `****-**${opts.kisAccountTail ?? "88"}`,
        htsIdSet: opts.kisHtsIdSet ?? true,
        source: opts.source ?? "file",
      }
    : null,
});

const listOf = (...keys: KiwoomKey[]): KiwoomKeyList => ({ keys, limit: 5, keyFileProblem: null });

const twoKeys = () => listOf(
  keyEntry("k1", "주계좌", CONNECTED, { market: true }),
  keyEntry("k2", "보조", { ...CONNECTED, appKeyTail: "5678" }),
);

const twoOrders = (second: "on" | "off" = "off"): OrdersStatus => ({
  state: "on",
  accountRef: "ref-k1",
  accountTail: "12",
  message: "주문 사용이 켜져 있습니다",
  accounts: [
    { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: "ref-k1", accountTail: "12" },
    { keyId: "k2", broker: "kiwoom", alias: "보조", market: false, state: second, accountRef: second === "on" ? "ref-k2" : null, accountTail: second === "on" ? "47" : null },
  ] satisfies OrdersAccount[],
});

const DEFAULT_SOURCE: MarketSourceStatus = {
  broker: "kiwoom",
  keyId: "k1",
  alias: "키 1",
  state: "connected",
  problem: null,
  step: "realtime",
  retryAt: null,
  features: [],
  feedBroker: { broker: "kiwoom", rankingKinds: [], rankingChoices: [], overviewFeatures: [] },
};

const SETTINGS: SystemSettings = {
  environment: "real",
  bind: "127.0.0.1:8080",
  logFilter: "info",
  kiwoomTarget: { kind: "kiwoom", host: null },
  screenerUpdateOnStart: true,
  dbPath: "/data/chart.db",
  screenerDbPath: "/data/screener.db",
  financialDbPath: "/data/fin.db",
  hogaDataDir: null,
  sharedDataDir: null,
  tokenPath: "/data/token.json",
  keyPath: "/data/keys.enc",
  lockPath: "/data/app.lock",
  staticDir: "/app/web/dist",
  serverVersion: "1.2.3",
  accountServerUrl: null,
  accountStatePath: null,
};

const usageTr = (apiId: string, minute: Partial<KiwoomUsageTr["lastMinute"]> = {}, rest: Partial<KiwoomUsageTr> = {}): KiwoomUsageTr => ({
  apiId,
  limit: 5,
  totalSent: 100,
  totalRateLimited: 0,
  ...rest,
  lastMinute: { sent: 12, maxPerSecond: 1, maxWaitMs: 0, rateLimited: 0, resent: 0, ...minute },
});

function setupApi(overrides: {
  link?: KiwoomLinkStatus;
  keys?: KiwoomKeyList;
  orders?: OrdersStatus;
  usage?: KiwoomUsage;
  marketSource?: MarketSourceStatus;
  handlers?: Record<string, (req: { method: string; pathname: string; rawBody: string | null; json(): unknown }) => unknown>;
} = {}) {
  let link = overrides.link ?? CONNECTED;
  let keys = overrides.keys ?? (link.keySource === "none" ? listOf() : listOf(keyEntry("k1", "키 1", link, { market: true })));
  let orders = overrides.orders ?? { state: "off", accountRef: null, accountTail: null, message: "", accounts: [] };
  let usage = overrides.usage ?? { lastMinuteStartedAt: Math.floor(Date.now() / 1000) - 90, totalRateLimited: 0, trs: [] };
  const source = overrides.marketSource ?? DEFAULT_SOURCE;

  const api = stubFetch((req) => {
    const custom = overrides.handlers?.[`${req.method} ${req.pathname}`];
    if (custom) return custom(req) as { status?: number; body?: unknown };
    if (req.pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (req.pathname === "/api/system/settings") return { body: SETTINGS };
    if (req.pathname === "/api/system/kiwoom") return { body: link };
    if (req.pathname === "/api/system/market-source") return { body: source };
    if (req.pathname === "/api/system/kiwoom/keys") return { body: keys };
    if (req.pathname === "/api/system/orders") return { body: orders };
    if (req.pathname === "/api/system/kiwoom/usage") return { body: usage };
    return { body: {} };
  });

  useKiwoomLinkStore.getState().receiveSnapshot(link, 0);
  useKiwoomLinkStore.getState().receiveSourceSnapshot(source, 0);

  return {
    api,
    setLink: (next: KiwoomLinkStatus) => {
      link = next;
      receiveKiwoomLinkPush(next);
    },
    setKeys: (next: KiwoomKeyList) => { keys = next; },
    setOrders: (next: OrdersStatus) => { orders = next; },
    setUsage: (next: KiwoomUsage) => { usage = next; },
  };
}

function renderSettings(menu: "kiwoom" | "general" | "data" | "about" = "kiwoom") {
  useSelectionStore.setState({ dialog: { kind: "system-settings", menu } });
  return renderWithProviders(
    <>
      <SystemSettingsDialog />
      <ConfirmHost />
    </>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useAccountStore.setState({ status: { state: "local_only" } });
  useKiwoomLinkStore.setState({ status: null, kiwoom: null, source: null, pushes: 0, sourcePushes: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

resetDomAfterEach();

test("키 없음 안내, 키 저장 후 연결 중복 클릭 방지, 시크릿 비노출", async () => {
  const saved: unknown[] = [];
  let resolveConnect!: (body: { status?: number; body?: unknown }) => void;
  const connectPromise = new Promise<{ status?: number; body?: unknown }>((resolve) => { resolveConnect = resolve; });

  const env = setupApi({
    link: NO_KEY,
    handlers: {
      "POST /api/system/kiwoom/keys": (req) => {
        saved.push(req.json());
        env.setLink(DISCONNECTED);
        const next = listOf(keyEntry("k1", "키움 1", DISCONNECTED, { market: true }));
        env.setKeys(next);
        return { body: next };
      },
      "POST /api/system/kiwoom/connect": () => connectPromise,
    },
  });

  const { client, container } = renderSettings("kiwoom");
  const panel = screen.getByRole("tabpanel");

  const steps = within(panel).getByRole("list", { name: "처음 연결하는 순서" });
  expect(within(steps).getAllByRole("listitem").map((el) => el.textContent)).toEqual([
    "1포털에서 앱키 받기",
    "2공인 IP 등록",
    "3여기에 붙여넣기",
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /^키움증권/ }));
  await screen.findByLabelText("별칭");

  fireEvent.change(screen.getByLabelText("앱키"), { target: { value: ` ${FAKE_KEY} ` } });
  fireEvent.change(screen.getByLabelText("시크릿"), { target: { value: FAKE_SECRET } });
  fireEvent.click(screen.getAllByRole("button", { name: "보기" })[0]!);
  fireEvent.submit(screen.getByRole("form", { name: "키 더하기" }));

  await screen.findByTestId("add-result");
  expect(saved).toEqual([{ alias: "키움 1", appKey: FAKE_KEY, appSecret: FAKE_SECRET }]);
  const visible = container.textContent ?? "";
  expect(visible).not.toContain(FAKE_KEY);
  expect(visible).not.toContain(FAKE_SECRET);
  expect(JSON.stringify({ ...localStorage })).not.toContain(FAKE_KEY);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(FAKE_SECRET);

  const connectBtn = await within(panel).findByRole("button", { name: "키움에 연결" });
  fireEvent.click(connectBtn);
  fireEvent.click(connectBtn);
  expect(env.api.callsTo("POST", "/api/system/kiwoom/connect")).toHaveLength(1);

  resolveConnect({ body: CONNECTED });
  expect(await within(panel).findByRole("heading", { name: "연결됨" })).toBeTruthy();
  expect(within(panel).getByText("서버를 다시 켜도 자동으로 연결합니다")).toBeTruthy();
  client.clear();
});

test("8050 확인 체크 2개와 대기 시간, 공인 IP 불일치 경고, 저장 실패 복구 및 파일 재확인", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const baseMs = Date.parse("2026-11-18T10:00:00+09:00");
  vi.setSystemTime(baseMs);
  const retryAt = Math.floor(baseMs / 1000) + 15;
  const blocked = failed("authBlocked8050", retryAt, BLOCKED_MSG, { needsAcknowledgement: true });

  let ipSaveShouldFail = true;
  const connectPayloads: unknown[] = [];
  const env = setupApi({
    link: blocked,
    handlers: {
      "POST /api/system/kiwoom/ip-check": () => ({ body: { ip: "1.2.3.4", checkedAt: retryAt } }),
      "PUT /api/system/kiwoom/registered-ip": () =>
        ipSaveShouldFail ? { status: 500, body: { error: { code: "internal", message: "IP 저장 실패", reason: null, retryAt: null, manualActionRequired: false } } } : { body: { ...blocked, registeredIp: { ip: "5.6.7.8", at: retryAt } } },
      "POST /api/system/kiwoom/connect": (req) => {
        connectPayloads.push(req.json());
        env.setLink(CONNECTED);
        return { body: CONNECTED };
      },
      "POST /api/system/kiwoom/recheck-token-file": () => {
        env.setLink(CONNECTED);
        return { body: CONNECTED };
      },
    },
  });

  const { client } = renderSettings("kiwoom");
  const panel = screen.getByRole("tabpanel");
  const retryBtn = await within(panel).findByRole("button", { name: /^다시 연결/ });
  expect((retryBtn as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(within(panel).getByRole("button", { name: "내 공인 IP 확인" }));
  await act(async () => { await Promise.resolve(); });
  expect(within(panel).getByText("1.2.3.4")).toBeTruthy();

  const ipCheck = within(panel).getByRole("checkbox", { name: /포털에 지금 공인 IP를 등록했습니다/ }) as HTMLInputElement;
  const lockCheck = within(panel).getByRole("checkbox", { name: /반복 발급 잠금이 풀렸는지 확인했습니다/ }) as HTMLInputElement;

  fireEvent.click(ipCheck);
  await act(async () => { await Promise.resolve(); });
  expect(ipCheck.checked).toBe(false);

  ipSaveShouldFail = false;
  fireEvent.click(ipCheck);
  await act(async () => { await Promise.resolve(); });
  expect(ipCheck.checked).toBe(true);
  expect(within(panel).getByText(/다릅니다/)).toBeTruthy();

  fireEvent.click(lockCheck);
  expect((retryBtn as HTMLButtonElement).disabled).toBe(true);

  await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
  expect((retryBtn as HTMLButtonElement).disabled).toBe(false);
  expect(env.api.callsTo("POST", "/api/system/kiwoom/connect")).toHaveLength(0);

  fireEvent.click(retryBtn);
  await waitFor(() => expect(connectPayloads).toEqual([{ acknowledged: true }]));

  env.setLink(failed("tokenFileUnusable", null, "토큰 파일 손상"));
  const recheckBtn = await within(panel).findByRole("button", { name: "파일 다시 확인" });
  fireEvent.click(recheckBtn);
  await act(async () => { await Promise.resolve(); });
  expect(env.api.callsTo("POST", "/api/system/kiwoom/recheck-token-file")).toHaveLength(1);
  client.clear();
});

test("복수 키, 별칭 변경 vs 재입력, 필드 오류 ARIA 매핑, 시세 공급원 변경 확인 및 주문 사용 스위치", async () => {
  const renameCalls: unknown[] = [];
  const orderCalls: unknown[] = [];
  const deleteCalls: string[] = [];

  const env = setupApi({
    keys: twoKeys(),
    orders: twoOrders("off"),
    handlers: {
      "POST /api/system/kiwoom/keys": () => ({ status: 400, body: { error: { code: "bad_request", message: "이미 등록한 앱키입니다", reason: null, retryAt: null, manualActionRequired: false } } }),
      "PUT /api/system/kiwoom/keys/k2/alias": (req) => {
        renameCalls.push(req.json());
        const next = listOf(keyEntry("k1", "주계좌", CONNECTED, { market: true }), keyEntry("k2", "이름바꿈", { ...CONNECTED, appKeyTail: "5678" }));
        env.setKeys(next);
        return { body: next };
      },
      "PUT /api/system/kiwoom/market-key": () => {
        const next = listOf(keyEntry("k1", "주계좌", CONNECTED, { market: false }), keyEntry("k2", "보조", { ...CONNECTED, appKeyTail: "5678" }, { market: true }));
        env.setKeys(next);
        return { body: next };
      },
      "POST /api/system/orders/check-account": () => ({ body: { accountTail: "47" } }),
      "PUT /api/system/orders": (req) => {
        orderCalls.push(req.json());
        const next = twoOrders("on");
        env.setOrders(next);
        return { body: next };
      },
      "DELETE /api/system/kiwoom/keys/k1": () => {
        deleteCalls.push("k1");
        const next = listOf(keyEntry("k2", "보조", { ...CONNECTED, appKeyTail: "5678" }, { market: true }));
        env.setKeys(next);
        return { body: next };
      },
    },
  });

  const { client } = renderSettings("kiwoom");
  const accounts = await screen.findByRole("region", { name: "계좌 목록" });
  await within(accounts).findByText("2 / 5");

  fireEvent.click(within(accounts).getByRole("button", { name: "＋ 계좌 연결 더하기" }));
  fireEvent.click(within(accounts).getByRole("button", { name: /^키움증권/ }));
  const addForm = within(accounts).getByRole("form", { name: "키 더하기" });
  const appKeyInput = within(addForm).getByLabelText("앱키");
  fireEvent.change(appKeyInput, { target: { value: FAKE_KEY } });
  fireEvent.change(within(addForm).getByLabelText("시크릿"), { target: { value: FAKE_SECRET } });
  fireEvent.submit(addForm);
  await waitFor(() => expect(appKeyInput.getAttribute("aria-invalid")).toBe("true"));
  expect(within(addForm).getAllByText("이미 등록한 앱키입니다").length).toBeGreaterThanOrEqual(1);
  fireEvent.click(within(addForm).getByRole("button", { name: "취소" }));

  fireEvent.click(within(accounts).getByRole("button", { name: /주계좌/ }));
  fireEvent.click(within(accounts).getAllByRole("button", { name: "지우기" })[0]!);
  const confirmRemove = await screen.findByRole("dialog", { name: "‘주계좌’ 키를 지웁니다" });
  expect(within(confirmRemove).getByRole("list").textContent).toContain("시세 키입니다");
  fireEvent.click(within(confirmRemove).getByRole("button", { name: "취소" }));
  expect(deleteCalls).toHaveLength(0);

  fireEvent.click(within(accounts).getByRole("button", { name: /보조/ }));
  fireEvent.click(within(accounts).getByRole("button", { name: "별칭·키 바꾸기" }));
  const editForm = within(accounts).getByRole("form", { name: "키 바꾸기" });
  fireEvent.change(within(editForm).getByLabelText("별칭"), { target: { value: "이름바꿈" } });
  fireEvent.submit(editForm);
  await waitFor(() => expect(renameCalls).toEqual([{ alias: "이름바꿈" }]));
  expect(env.api.callsTo("PUT", "/api/system/kiwoom/keys/k2/key")).toHaveLength(0);

  const rowOrders = within(accounts).getByTestId("key-orders");
  fireEvent.click(within(rowOrders).getByRole("switch", { name: "주문 사용" }));
  const enableBtn = await within(rowOrders).findByRole("button", { name: "실전 주문 켜기" });
  expect((enableBtn as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(rowOrders).getByRole("checkbox", { name: "이 계좌가 맞습니다" }));
  fireEvent.click(enableBtn);
  await waitFor(() => expect(orderCalls).toEqual([{ enabled: true, confirmAccountTail: "47", keyId: "k2" }]));

  const picker = screen.getByRole("combobox", { name: "시세 키" });
  fireEvent.click(picker);
  const listbox = await screen.findByRole("menu", { name: "시세 키" });
  fireEvent.click(within(listbox).getByRole("menuitemradio", { name: /이름바꿈|보조/ }));
  const confirmMarket = await screen.findByRole("dialog", { name: /시세를 .* 받습니다/ });
  fireEvent.click(within(confirmMarket).getByRole("button", { name: "취소" }));
  expect(env.api.callsTo("PUT", "/api/system/kiwoom/market-key")).toHaveLength(0);
  client.clear();
});

test("KIS 계좌 제약 안내, HTS ID 없음 경고, OPSP8996 다른 프로그램 사용 중, 5개 상한 비활성", async () => {
  const kisKey = keyEntry("k-kis", "한투 메인", { ...CONNECTED, message: "연결됨" }, { broker: "kis", market: true, kisAccountTail: "88", kisHtsIdSet: false });
  const envKeys: KiwoomKey[] = [1, 2, 3, 4, 5].map((n) => keyEntry(`km${n}`, `키${n}`, CONNECTED, { market: n === 1 }));
  const otherKis = keyEntry("k-kis-2", "한투 보조", failed("network", null, "OPSP8996"), { broker: "kis", kisAccountTail: null, kisHtsIdSet: false });

  setupApi({
    link: CONNECTED,
    keys: listOf(kisKey, ...envKeys, otherKis),
    orders: {
      state: "off",
      accountRef: null,
      accountTail: null,
      message: "",
      accounts: [
        { keyId: "k-kis", broker: "kis", alias: "한투 메인", market: true, state: "off", accountRef: null, accountTail: "88" },
        { keyId: "k-kis-2", broker: "kis", alias: "한투 보조", market: false, state: "off", accountRef: null, accountTail: null },
      ],
    },
    marketSource: {
      broker: "kis",
      keyId: "k-kis",
      alias: "한투 메인",
      state: "connected",
      problem: null,
      step: "realtime",
      retryAt: null,
      features: ["quotes", "orderBook"],
      feedBroker: { broker: "kiwoom", rankingKinds: [], rankingChoices: [], overviewFeatures: [] },
    },
  });

  const { client } = renderSettings("kiwoom");
  expect(await screen.findByTestId("feed-line")).toBeTruthy();
  expect(screen.getByTestId("feed-line").textContent).toContain("키움");

  const accounts = screen.getByRole("region", { name: "계좌 목록" });
  fireEvent.click(await within(accounts).findByRole("button", { name: "＋ 계좌 연결 더하기" }));
  const kiwoomChoice = within(accounts).getByRole("button", { name: /^키움증권/ }) as HTMLButtonElement;
  expect(kiwoomChoice.disabled).toBe(true);
  fireEvent.click(within(accounts).getByRole("button", { name: "취소" }));

  fireEvent.click(within(accounts).getByRole("button", { name: /한투 메인/ }));
  expect(await within(accounts).findByTestId("kis-hts-note")).toBeTruthy();

  fireEvent.click(within(accounts).getByRole("button", { name: /한투 보조/ }));
  expect(await within(accounts).findByTestId("kis-no-account-note")).toBeTruthy();
  expect(within(accounts).getByTestId("in-use-elsewhere").textContent).toContain("다른 프로그램");
  client.clear();
});

test("목록 폴링 지연 시 삭제·추가 상태 유지, 키 수정·재연결 시 8050 확인 초기화", async () => {
  const blocked = failed("authBlocked8050", null, BLOCKED_MSG, { appKeyTail: "5678", needsAcknowledgement: true });
  const first = keyEntry("k1", "주계좌", CONNECTED, { market: true });
  const second = keyEntry("k2", "보조", blocked);
  const initialList = listOf(first, second);

  let releaseStaleGet!: (res: { body: KiwoomKeyList }) => void;
  let getCalls = 0;
  let currentList = initialList;
  const env = setupApi({
    keys: initialList,
    handlers: {
      "GET /api/system/kiwoom/keys": () => {
        getCalls += 1;
        if (getCalls === 2) return new Promise((resolve) => { releaseStaleGet = resolve; });
        return { body: currentList };
      },
      "DELETE /api/system/kiwoom/keys/k1": () => {
        currentList = listOf(second);
        return { body: currentList };
      },
      "PUT /api/system/kiwoom/keys/k2/key": () => {
        currentList = listOf(first, { ...second, appKeyTail: "9X9X", link: { ...blocked, appKeyTail: "9X9X" } });
        return { body: currentList };
      },
    },
  });

  const { client } = renderSettings("kiwoom");
  const accounts = await screen.findByRole("region", { name: "계좌 목록" });
  await waitFor(() => expect(within(accounts).getAllByRole("listitem")).toHaveLength(2));

  fireEvent.click(within(accounts).getByRole("button", { name: /주계좌/ }));
  fireEvent.click(within(accounts).getByRole("button", { name: "지우기" }));
  fireEvent.click((await screen.findByRole("dialog", { name: /주계좌/ })).querySelector("button.btn-danger")!);
  await waitFor(() => expect(within(accounts).getAllByRole("listitem")).toHaveLength(1));

  releaseStaleGet?.({ body: initialList });
  await act(async () => { await Promise.resolve(); });
  expect(within(accounts).getAllByRole("listitem")).toHaveLength(1);

  fireEvent.click(within(accounts).getByRole("button", { name: /보조/ }));
  const ipCheck = within(accounts).getByRole("checkbox", { name: /포털에 지금 공인 IP를 등록했습니다/ }) as HTMLInputElement;
  const lockCheck = within(accounts).getByRole("checkbox", { name: /반복 발급 잠금이 풀렸는지 확인했습니다/ }) as HTMLInputElement;
  fireEvent.click(ipCheck);
  fireEvent.click(lockCheck);
  expect((within(accounts).getByRole("button", { name: "다시 연결" }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(within(accounts).getByRole("button", { name: "별칭·키 바꾸기" }));
  const form = within(accounts).getByRole("form", { name: "키 바꾸기" });
  fireEvent.change(within(form).getByLabelText("앱키"), { target: { value: "NEWKEYabcdefgh9X9X" } });
  fireEvent.change(within(form).getByLabelText("시크릿"), { target: { value: "NEWSECRETvalue" } });
  fireEvent.submit(form);

  await waitFor(() => expect(within(accounts).getByText("••••••••••••9X9X")).toBeTruthy());
  expect((within(accounts).getByRole("checkbox", { name: /포털에 지금 공인 IP를 등록했습니다/ }) as HTMLInputElement).checked).toBe(false);
  expect((within(accounts).getByRole("button", { name: "다시 연결" }) as HTMLButtonElement).disabled).toBe(true);
  void env;
  client.clear();
});

test("호출 한도 카드, 읽기 전용 일반/데이터/정보 탭, 네이티브 select 미사용 및 유휴 시 DOM 무변화", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const baseMs = Date.parse("2026-11-18T10:00:00+09:00");
  vi.setSystemTime(baseMs);
  const env = setupApi({
    keys: twoKeys(),
    orders: twoOrders("off"),
    usage: {
      lastMinuteStartedAt: Math.floor(baseMs / 1000) - 90,
      totalRateLimited: 1,
      trs: [
        usageTr("ka10001", { sent: 20, maxPerSecond: 4, maxWaitMs: 350, rateLimited: 1 }, { totalRateLimited: 1 }),
        usageTr("kt10000", { sent: 5, maxPerSecond: 5, maxWaitMs: 120 }),
      ],
    },
  });

  const { client, container } = renderSettings("kiwoom");
  const usageCard = await screen.findByRole("region", { name: "호출 한도" });
  expect(within(usageCard).getByText("제한 응답 있음")).toBeTruthy();
  expect(within(usageCard).getByText("한도에 닿음")).toBeTruthy();
  expect(within(usageCard).getByTestId("usage-total-limited").textContent).toContain("1건");
  expect(container.querySelectorAll("select")).toHaveLength(0);

  const countBefore = env.api.callsTo("GET", "/api/system/kiwoom/usage").length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
  expect(env.api.callsTo("GET", "/api/system/kiwoom/usage").length).toBeGreaterThan(countBefore);

  let mutations = 0;
  const observer = new MutationObserver((records) => { mutations += records.length; });
  observer.observe(screen.getByRole("tabpanel"), { subtree: true, childList: true, characterData: true, attributes: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  observer.disconnect();
  expect(mutations).toBe(0);

  fireEvent.click(screen.getByRole("tab", { name: "일반" }));
  expect(await screen.findByRole("region", { name: "일반 설정" })).toBeTruthy();
  expect(container.querySelectorAll("select")).toHaveLength(0);
  fireEvent.click(screen.getByRole("tab", { name: "데이터 · 저장소" }));
  expect(await screen.findByRole("region", { name: "데이터 저장소" })).toBeTruthy();
  client.clear();
});
