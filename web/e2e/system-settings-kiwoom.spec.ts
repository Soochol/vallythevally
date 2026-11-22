import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { KiwoomConnectInput } from "../src/api/generated/KiwoomConnectInput";
import type { KiwoomKey } from "../src/api/generated/KiwoomKey";
import type { KiwoomKeyAdd } from "../src/api/generated/KiwoomKeyAdd";
import type { KiwoomKeyAlias } from "../src/api/generated/KiwoomKeyAlias";
import type { KiwoomMarketKeyInput } from "../src/api/generated/KiwoomMarketKeyInput";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { KiwoomUsage } from "../src/api/generated/KiwoomUsage";
import type { KiwoomUsageTr } from "../src/api/generated/KiwoomUsageTr";
import type { OrdersStatus } from "../src/api/generated/OrdersStatus";
import type { OrdersSwitchInput } from "../src/api/generated/OrdersSwitchInput";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import type { RegisteredIpInput } from "../src/api/generated/RegisteredIpInput";
import { cell, expect, fixedWait, test, type Scenario, pollSaved } from "./harness";
import { CONNECTED_KIWOOM, keyEntry, keyListOf } from "./fixtures/scenario";

const SCREENS = path.resolve("../target/ux-screens");
const FAKE_APP_KEY = "FAKEAPPKEYabcdefgh7Z2D";
const FAKE_APP_SECRET = "FAKESECRETvalue0123456789xyz";
const BLOCKED_MESSAGE = "키움이 지정단말기 인증을 거절했습니다(8050). 고친 뒤 아래에서 다시 연결하세요. 서버를 다시 켤 필요는 없습니다";

const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다", realtimeRegistered: null, symbolCount: null };
const DISCONNECTED: KiwoomLinkStatus = { ...NO_KEY, keySource: "file", appKeyTail: "7Z2D", state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다" };
const failed = (problem: NonNullable<KiwoomLinkStatus["problem"]>, retryAt: number | null, message: string, patch: Partial<KiwoomLinkStatus> = {}): KiwoomLinkStatus =>
  ({ ...DISCONNECTED, state: "failed", problem, retryAt, message, ...patch });

const serverSeconds = (scenario: Scenario) => Math.floor(scenario.now / 1000);
const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const panel = (page: Page) => dialog(page).getByRole("tabpanel");
const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);

const passTime = async (page: Page, ms: number) => {
  await page.clock.runFor(ms);
  await fixedWait(page, ms, "요청이 나가지 않았음을 보려면 원래 대기만큼 실제 시간이 지나야 한다");
};

const KEYS = "/api/system/kiwoom/keys";
const accounts = (page: Page) => panel(page).getByRole("region", { name: "계좌 목록" });
const marketCard = (page: Page) => panel(page).getByRole("region", { name: "시세 공급원" });
const keyRows = (page: Page) => accounts(page).getByRole("listitem");
const expandKey = (page: Page, alias: string) => accounts(page).getByRole("button", { name: alias, exact: false }).first().click();
const singleKey = (link: KiwoomLinkStatus) => keyListOf(keyEntry("k1", "키 1", link, { market: true }));
const twoKeys = () => keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }), keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" }));
const twoOrders = ({ second = "off" }: { second?: "on" | "off" } = {}): OrdersStatus => ({
  state: "on", accountRef: "ref-k1", accountTail: "12", message: "주문 사용이 켜져 있습니다",
  accounts: [
    { keyId: "k1", alias: "주계좌", market: true, state: "on", accountRef: "ref-k1", accountTail: "12" },
    { keyId: "k2", alias: "보조", market: false, state: second, accountRef: second === "on" ? "ref-k2" : null, accountTail: second === "on" ? "47" : null },
  ],
});
const refusal = (message: string) => ({ status: 400, body: { error: { code: "bad_request", message, reason: null, retryAt: null, manualActionRequired: false } } });

const USAGE_PATH = "/api/system/kiwoom/usage";
const usageTr = (apiId: string, minute: Partial<KiwoomUsageTr["lastMinute"]> = {}, rest: Partial<KiwoomUsageTr> = {}): KiwoomUsageTr => ({
  apiId, limit: 5, totalSent: 100, totalRateLimited: 0, ...rest,
  lastMinute: { sent: 12, maxPerSecond: 1, maxWaitMs: 0, rateLimited: 0, resent: 0, ...minute },
});
const usageCard = (page: Page) => panel(page).getByRole("region", { name: "호출 한도" });

async function openKiwoom(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, name) });
}

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("키 없음 → 키 저장 → 연결 안 함 → 연결 → 연결 중 → 연결됨, 연결 요청은 연타에도 하나", async ({ page, scenario }) => {
    const consoleText: string[] = [];
    page.on("console", (m) => consoleText.push(m.text()));
    scenario.live.kiwoomLink = NO_KEY;
    const saved: KiwoomKeyAdd[] = [];
    scenario.on(route("POST", KEYS), (request) => {
      saved.push(request.postDataJSON());
      scenario.live.link(DISCONNECTED);
      return { body: singleKey(DISCONNECTED) };
    });
    const connect = scenario.hold(route("POST", "/api/system/kiwoom/connect"));

    await openKiwoom(page);
    await expect(panel(page)).toContainText("키 없음");
    await expect(panel(page).getByRole("button", { name: "키움에 연결" })).toBeDisabled();
    await expect(panel(page)).toContainText("저장하면 바로 키움에 연결합니다. 포털에 지금 공인 IP를 먼저 등록하세요");
    await expect(panel(page)).toContainText("키움 REST · api.kiwoom.com (고정)");
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("type", "password");
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("autocomplete", "off");
    await shot(page, "kiwoom-1440x900-no-key.png");

    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "입력 보기" }).click();
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("type", "text");
    await expect(page.getByLabel("별칭", { exact: true })).toHaveValue("키움 1");
    await page.getByRole("button", { name: "저장하고 연결" }).click();

    await expect(accounts(page).getByRole("button", { name: "닫기" })).toBeVisible();
    expect(saved).toEqual([{ alias: "키움 1", appKey: FAKE_APP_KEY, appSecret: FAKE_APP_SECRET }]);
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);
    await expandKey(page, "키 1");
    await expect(panel(page)).toContainText("••••••••••••7Z2D");
    await expect(panel(page)).toContainText("화면에서 저장");
    await expect(page.locator("input[type=password], input[type=text]")).toHaveCount(0);

    const html = await page.content();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const secret of [FAKE_APP_KEY, FAKE_APP_SECRET]) {
      expect(html).not.toContain(secret);
      expect(await page.locator("body").innerText()).not.toContain(secret);
      expect(storage).not.toContain(secret);
      expect(consoleText.join("\n")).not.toContain(secret);
    }
    for (const request of scenario.requests) {
      for (const secret of [FAKE_APP_KEY, FAKE_APP_SECRET]) {
        expect(decodeURIComponent(request.url())).not.toContain(secret);
        expect(JSON.stringify(await request.allHeaders())).not.toContain(secret);
      }
    }
    const [post] = callsTo(scenario, "POST", KEYS);
    expect(new URL(post!.url()).search).toBe("");
    expect(await post!.headerValue("content-type")).toContain("application/json");

    await panel(page).getByRole("button", { name: "키움에 연결" }).dblclick();
    await connect.received;
    scenario.live.link({ ...DISCONNECTED, state: "connecting", step: "token", message: "키움에 연결하는 중입니다" });
    await expect(panel(page).getByRole("heading", { name: "연결 중" })).toBeVisible();
    await expect(panel(page).getByRole("listitem").filter({ hasText: "2. 토큰" })).toHaveAttribute("aria-current", "step");
    await expect(panel(page).getByRole("button", { name: /취소/ })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "별칭·키 바꾸기" })).toBeDisabled();

    const connected: KiwoomLinkStatus = { ...DISCONNECTED, state: "connected", message: "키움에 연결됨", tokenExpiresAt: serverSeconds(scenario) + 86_400, realtimeRegistered: 3, symbolCount: 2812 };
    scenario.live.link(connected);
    connect.reply({ body: connected });
    await expect(panel(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
    await expect(panel(page)).toContainText("2812종목");
    await expect(panel(page)).toContainText("3종목");
    await expect(panel(page).getByRole("button", { name: "연결 끊기" })).toBeVisible();
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(1);
    expect(scenario.requests.find((r) => new URL(r.url()).pathname === "/api/system/kiwoom/connect")!.postDataJSON()).toEqual({ acknowledged: false } satisfies KiwoomConnectInput);
    await shot(page, "kiwoom-1440x900-connected.png");
  });

  test("연결됨: 서버를 다시 켜도 자동 연결한다는 안내와 끊으면 다음에도 연결하지 않는다는 설명이 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = CONNECTED_KIWOOM;
    await openKiwoom(page);
    await expect(panel(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
    await expect(panel(page)).toContainText("서버를 다시 켜도 자동으로 연결합니다");
    await expect(panel(page)).toContainText("끊으면 다음에 서버를 켤 때도 연결하지 않습니다");
  });

  test("연결 안 함: 시작 때 연결 값에 따라 안내가 다르다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, atStart: "connects" };
    await openKiwoom(page);
    await expect(panel(page)).toContainText("키는 저장됨 · 연결하지 않았습니다");
    scenario.live.link({ ...DISCONNECTED, atStart: "keptDisconnected" });
    await expect(panel(page)).toContainText("연결을 끊어 두었습니다. 연결하면 다음부터 서버를 켤 때 자동으로 연결합니다");
  });

  test("연결 중 발급 간격 대기: 남은 시간이 줄고 저절로 이어 연결하며 끊기만 있고 연결 요청은 나가지 않는다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, state: "connecting", step: "issueInterval", retryAt: serverSeconds(scenario) + 400, message: "키움 토큰 발급 간격을 기다립니다" };
    await openKiwoom(page);
    await expect(panel(page).getByRole("heading", { name: "발급 간격 대기" })).toBeVisible();
    await expect(panel(page)).toContainText(/\d:\d\d 뒤 저절로 이어 연결합니다/);
    await expect(panel(page).getByRole("button", { name: "연결 끊기" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: /연결$|다시 연결/ })).toHaveCount(0);
    const before = await panel(page).innerText();
    await expect.poll(async () => (await panel(page).innerText()) !== before, { timeout: 4000 }).toBe(true);
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);
  });

  test("8050 차단은 재시작해도 풀리지 않는다고 알리고, 키 폼은 확인 전에는 연결하지 않는다고 알린다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    await openKiwoom(page);
    await expect(panel(page)).toContainText("서버를 다시 켜도 차단은 풀리지 않고 자동 연결도 하지 않습니다");
    await expandKey(page, "키 1");
    await panel(page).getByRole("button", { name: "별칭·키 바꾸기" }).click();
    await expect(panel(page)).toContainText("8050 확인을 마치기 전에는 저장해도 연결하지 않습니다");
    await expect(panel(page)).not.toContainText("저장하면 바로 키움에 연결합니다");
  });

  test("키 폼 안내의 링크가 공인 IP 도움말을 연다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    await openKiwoom(page);
    const help = panel(page).getByRole("button", { name: "공인 IP 확인 · 포털 안내", exact: true });
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await panel(page).getByRole("button", { name: "공인 IP 확인 · 포털 안내 열기" }).click();
    await expect(help).toHaveAttribute("aria-expanded", "true");
  });

  test("환경 키는 저장 안내가 없다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, keySource: "env", appKeyTail: "ENV4" };
    await openKiwoom(page);
    await expect(panel(page)).not.toContainText("저장하면 바로 키움에 연결합니다");
  });

  test("키를 지우기 전에 확인을 받고 확인하면 지운다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = DISCONNECTED;
    scenario.on(route("DELETE", `${KEYS}/k1`), () => { scenario.live.link(NO_KEY); return { body: keyListOf() }; });
    await openKiwoom(page);
    await expandKey(page, "키 1");
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: /시세 키입니다/ }).getByRole("button", { name: "취소" }).click();
    expect(callsTo(scenario, "DELETE", `${KEYS}/k1`)).toHaveLength(0);
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: /시세 키입니다/ }).getByRole("button", { name: "키 지우기" }).click();
    await expect(panel(page).getByRole("heading", { name: "키 없음" })).toBeVisible();
    const deletes = callsTo(scenario, "DELETE", `${KEYS}/k1`);
    expect(deletes).toHaveLength(1);
    expect(await deletes[0]!.headerValue("content-type")).toContain("application/json");
  });

  test("저장하고 지워 키 없음으로 돌아오면 입력칸은 비어 있다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    scenario.on(route("POST", KEYS), () => { scenario.live.link(DISCONNECTED); return { body: singleKey(DISCONNECTED) }; });
    scenario.on(route("DELETE", `${KEYS}/k1`), () => { scenario.live.link(NO_KEY); return { body: keyListOf() }; });
    await openKiwoom(page);
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장하고 연결" }).click();
    await accounts(page).getByRole("button", { name: "닫기" }).click();
    await expandKey(page, "키 1");
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: /시세 키입니다/ }).getByRole("button", { name: "키 지우기" }).click();
    await expect(page.getByLabel("앱키", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("시크릿", { exact: true })).toHaveValue("");
  });

  test("env 키 줄은 .env 표시가 있고 바꾸기·지우기 단추가 없다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, keySource: "env", appKeyTail: "ENV4" };
    await openKiwoom(page);
    await expect(keyRows(page)).toHaveCount(1);
    await expect(keyRows(page).first()).toContainText(".env");
    await expandKey(page, "환경 설정 키");
    await expect(panel(page)).toContainText(".env에서 읽음 · 읽기 전용");
    await expect(panel(page)).toContainText("••••••••••••ENV4");
    await expect(panel(page)).toContainText("바꾸려면 .env에서 해당 줄을 지우세요");
    await expect(panel(page).getByRole("button", { name: /바꾸기/ })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "지우기" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "저장" })).toHaveCount(0);
    await expect(panel(page).locator("input")).toHaveCount(0);
    await shot(page, "kiwoom-1440x900-env-key.png");
  });

  test("8050: 체크 하나로는 꺼져 있고, 둘 다 체크해도 간격 전이면 꺼져 있고, 간격 뒤에 켜져 acknowledged로 보낸다", async ({ page, scenario }) => {
    const retryAt = serverSeconds(scenario) + 570;
    scenario.live.kiwoomLink = failed("authBlocked8050", retryAt, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    const checked: PublicIpCheck = { ip: "203.0.113.7", checkedAt: serverSeconds(scenario) };
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: checked }));
    const registered: RegisteredIpInput[] = [];
    scenario.on(route("PUT", "/api/system/kiwoom/registered-ip"), (request) => {
      registered.push(request.postDataJSON());
      const next = { ...scenario.live.kiwoomLink, registeredIp: { ip: registered.at(-1)!.ip, at: serverSeconds(scenario) } };
      scenario.live.link(next);
      return { body: next };
    });
    const connect = scenario.hold(route("POST", "/api/system/kiwoom/connect"));

    await openKiwoom(page);
    await expect(panel(page)).toContainText(BLOCKED_MESSAGE);
    const reconnect = panel(page).getByRole("button", { name: /^다시 연결/ });
    const ipHelp = panel(page).getByRole("button", { name: /공인 IP 확인 · 포털 안내/ });
    await expect(ipHelp).toHaveAttribute("aria-expanded", "true");
    await expect(reconnect).toBeDisabled();
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/ip-check")).toHaveLength(0);

    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page)).toContainText("203.0.113.7");
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await pollSaved(() => registered).toEqual([{ ip: "203.0.113.7" }]);
    await expect(panel(page)).toContainText("마지막으로 포털에 등록한 IP");
    await expect(reconnect).toBeDisabled();
    await shot(page, "kiwoom-1440x900-blocked-8050.png");

    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await expect(reconnect).toBeDisabled();
    await expect(reconnect).toContainText("뒤 가능");

    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: checked, headers: { date: new Date(scenario.now + 600_000).toUTCString() } }));
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(reconnect).toBeEnabled({ timeout: 5000 });
    await expect(reconnect).toHaveText("다시 연결");
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);

    await reconnect.click();
    await connect.received;
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")[0]!.postDataJSON()).toEqual({ acknowledged: true } satisfies KiwoomConnectInput);
    connect.reply({ body: { ...CONNECTED_KIWOOM } });
  });

  test("등록한 IP 저장이 실패하면 확인이 풀려 다시 연결 단추가 꺼진 채다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "203.0.113.7", checkedAt: serverSeconds(scenario) } satisfies PublicIpCheck }));
    scenario.on(route("PUT", "/api/system/kiwoom/registered-ip"), () => ({ status: 500, body: { error: { code: "internal", message: "등록한 IP를 파일에 쓰지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } } }));
    await openKiwoom(page);
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page)).toContainText("203.0.113.7");
    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await expect(panel(page).getByRole("alert").filter({ hasText: "등록한 IP를 파일에 쓰지 못했습니다" })).toBeVisible();
    await expect(panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다")).not.toBeChecked();
    await expect(panel(page).getByRole("button", { name: /^다시 연결/ })).toBeDisabled();
  });

  test("연결을 눌러 8050이 다시 오면 확인 칸을 다시 받는다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    const refused = failed("authBlocked8050", serverSeconds(scenario) + 600, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    scenario.on(route("POST", "/api/system/kiwoom/connect"), () => { scenario.live.link(refused); return { body: refused }; });
    await openKiwoom(page);
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await panel(page).getByRole("button", { name: /^다시 연결/ }).click();
    await expect(panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).not.toBeChecked();
    await expect(panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다")).not.toBeChecked();
    await expect(panel(page).getByRole("button", { name: /^다시 연결/ })).toBeDisabled();
  });

  test("확인한 연결이 간격 안이라 대기로 돌아와도 확인은 남고, 간격 뒤 acknowledged로 다시 보낸다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    const waiting = failed("issueIntervalWait", serverSeconds(scenario) + 3, "키움 토큰은 발급 사이를 10분 띄웁니다", { needsAcknowledgement: true });
    const bodies: KiwoomConnectInput[] = [];
    scenario.on(route("POST", "/api/system/kiwoom/connect"), (request) => {
      bodies.push(request.postDataJSON());
      if (bodies.length === 1) {
        scenario.live.link({ ...waiting, state: "connecting", problem: null, retryAt: null, step: "checkingKey", message: "키움에 연결하는 중입니다" });
        scenario.live.link(waiting);
        return { body: waiting };
      }
      return { body: CONNECTED_KIWOOM };
    });
    await openKiwoom(page);
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await panel(page).getByRole("button", { name: /^다시 연결/ }).click();
    const reconnect = panel(page).getByRole("button", { name: /^다시 연결/ });
    await expect(reconnect).toContainText("뒤 가능");
    await expect(panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).toBeChecked();
    await expect(reconnect).toBeEnabled({ timeout: 8000 });
    await reconnect.click();
    await pollSaved(() => bodies).toEqual([{ acknowledged: true }, { acknowledged: true }]);
  });

  test("8050에서 확인한 뒤 키를 바꾸면 확인 칸을 다시 받는다", async ({ page, scenario }) => {
    const blocked = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    scenario.live.kiwoomLink = blocked;
    scenario.on(route("PUT", `${KEYS}/k1/key`), () => { const next = { ...blocked, appKeyTail: "9X9X" }; scenario.live.link(next); return { body: singleKey(next) }; });
    await openKiwoom(page);
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await expect(panel(page).getByRole("button", { name: /^다시 연결/ })).toBeEnabled();
    await expandKey(page, "키 1");
    await panel(page).getByRole("button", { name: "별칭·키 바꾸기" }).click();
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).not.toBeChecked();
    await expect(panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다")).not.toBeChecked();
    await expect(panel(page).getByRole("button", { name: /^다시 연결/ })).toBeDisabled();
  });

  test("등록한 IP를 저장하는 동안 푸시가 와도 저장한 IP가 보인다", async ({ page, scenario }) => {
    const blocked = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    scenario.live.kiwoomLink = blocked;
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "203.0.113.7", checkedAt: serverSeconds(scenario) } satisfies PublicIpCheck }));
    const saving = scenario.hold(route("PUT", "/api/system/kiwoom/registered-ip"));
    await openKiwoom(page);
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page)).toContainText("203.0.113.7");
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await saving.received;
    scenario.live.link({ ...blocked, message: BLOCKED_MESSAGE });
    saving.reply({ body: { ...blocked, registeredIp: { ip: "203.0.113.7", at: serverSeconds(scenario) } } });
    await expect(panel(page)).toContainText("마지막으로 포털에 등록한 IP 203.0.113.7");
  });

  test("연결 중을 거쳐 푸시만으로 8050이 다시 오면 확인 칸을 다시 받는다", async ({ page, scenario }) => {
    const blocked = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    scenario.live.kiwoomLink = blocked;
    await openKiwoom(page);
    await panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    scenario.live.link({ ...blocked, state: "connecting", problem: null, step: "token", message: "키움에 연결하는 중입니다" });
    await expect(panel(page).getByRole("heading", { name: "연결 중" })).toBeVisible();
    scenario.live.link(blocked);
    await expect(panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).not.toBeChecked();
    await expect(panel(page).getByLabel("포털에 지금 공인 IP를 등록했습니다")).not.toBeChecked();
    await expect(panel(page).getByRole("button", { name: /^다시 연결/ })).toBeDisabled();
  });

  test("체크 칸을 키보드로 눌러도 초점이 칸에 남는다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    await openKiwoom(page);
    const lock = panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다");
    await lock.focus();
    await page.keyboard.press("Space");
    await expect(lock).toBeChecked();
    await expect(lock).toBeFocused();
  });

  test("8050 확인 칸은 8050이 풀리면 비워진다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true });
    await openKiwoom(page);
    const lock = panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다");
    await lock.check();
    scenario.live.link(DISCONNECTED);
    await expect(lock).toHaveCount(0);
    scenario.live.link(failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true }));
    await expect(panel(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).not.toBeChecked();
  });

  test("발급 간격 대기: 0이 되면 단추가 켜지지만 저절로 요청하지 않는다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("issueIntervalWait", serverSeconds(scenario) + 4, "키움 토큰은 발급 사이를 10분 띄웁니다");
    await page.clock.install();
    await openKiwoom(page);
    const reconnect = panel(page).getByRole("button", { name: /^다시 연결/ });
    await expect(panel(page)).toContainText("다음 발급 가능");
    await expect(reconnect).toBeDisabled();
    await expect(reconnect).toContainText("뒤 가능");
    await shot(page, "kiwoom-1440x900-interval-wait.png");
    await expect(reconnect).toBeEnabled({ timeout: 8000 });
    await expect(reconnect).toHaveText("다시 연결");
    await expect(panel(page)).toContainText("지금 연결할 수 있습니다");
    await passTime(page, 1500);
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);
  });

  test("토큰 파일 사용 불가는 파일 다시 확인만 있고, 경로 멈춤은 서버 로그를 안내한다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("tokenFileUnusable", null, "토큰 파일을 쓸 수 없어 키움 토큰을 발급하지 않습니다(권한)");
    scenario.on(route("POST", "/api/system/kiwoom/recheck-token-file"), () => ({ body: DISCONNECTED }));
    await openKiwoom(page);
    await expect(panel(page)).toContainText("state/kiwoom-token.json");
    await expect(panel(page)).toContainText("키움에는 아무것도 보내지 않습니다");
    await panel(page).getByRole("button", { name: "파일 다시 확인" }).click();
    await expect(panel(page).getByRole("heading", { name: "연결 안 함" })).toBeVisible();
    scenario.live.link(failed("pathStopped", null, "경로가 멈췄습니다"));
    await expect(panel(page)).toContainText("서버 로그를 확인하세요");
    await expect(panel(page).getByRole("button", { name: /^(키움에 연결|다시 연결|다시 시도|연결 끊기)/ })).toHaveCount(0);
  });

  test("8050이 아닌 인증 차단은 키 확인 한 문장과 키 바꾸기를 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("keyNeedsCheck", null, "키움 인증에 실패했습니다");
    await openKiwoom(page);
    await expect(panel(page)).toContainText("앱키·시크릿을 확인하세요");
    await expandKey(page, "키 1");
    await expect(panel(page).getByRole("button", { name: "별칭·키 바꾸기" })).toBeEnabled();
    await expect(panel(page).getByRole("checkbox")).toHaveCount(0);
  });

  test("공인 IP를 확인하고, 등록한 IP와 다르면 경고한다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, registeredIp: { ip: "198.51.100.1", at: serverSeconds(scenario) - 3600 } };
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "203.0.113.7", checkedAt: serverSeconds(scenario) } satisfies PublicIpCheck }));
    await openKiwoom(page);
    const help = panel(page).getByRole("button", { name: /공인 IP 확인 · 포털 안내/ });
    await expect(help).toHaveAttribute("aria-expanded", "false");
    await help.click();
    await expect(panel(page)).toContainText("누를 때만 서버가 외부 서비스에 한 번 묻습니다");
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/ip-check")).toHaveLength(0);
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page)).toContainText("203.0.113.7");
    await expect(panel(page)).toContainText("마지막 확인");
    await expect(panel(page).getByRole("alert")).toContainText("지금 공인 IP와 다릅니다. 공유기·통신사에서 IP가 바뀌었을 수 있습니다");
    await expect(panel(page)).toContainText("메뉴 이름은 실제 화면과 다를 수 있습니다");
    const portal = panel(page).getByRole("link", { name: "키움 포털 열기 (새 탭)" });
    await expect(portal).toHaveAttribute("href", "https://openapi.kiwoom.com");
    await expect(portal).toHaveAttribute("target", "_blank");
    await expect(portal).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("시스템 설정에 주문 카드가 없고, 계좌 줄을 펼치면 그 계좌의 주문 사용 켜기가 끝 2자리 확인을 거쳐 그 키 ID로 나간다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    scenario.live.ordersAccountTails = { k2: "47" };
    await openKiwoom(page);
    await expect(panel(page).getByRole("region", { name: "주문 사용" })).toHaveCount(0);
    const [first, second] = [keyRows(page).nth(0), keyRows(page).nth(1)];
    await expect(first.getByTestId("key-account")).toHaveText("****-**12");
    await expect(first.getByTestId("key-order-mark")).toHaveText("주문 켜짐");
    await expect(second.getByTestId("key-account")).toHaveText("켤 때 확인");
    await expect(second.getByTestId("key-order-mark")).toHaveText("주문 꺼짐");

    await expandKey(page, "보조");
    const orders = second.getByRole("region", { name: "주문 사용" });
    await expect(orders.getByRole("button", { name: "주문 사용 끄기" })).toHaveCount(0);
    expect(callsTo(scenario, "POST", "/api/system/orders/check-account")).toHaveLength(0);
    await orders.getByRole("button", { name: "주문 사용 켜기" }).click();
    await expect(orders).toContainText("계좌번호(8자리) 끝 2자리: 47");
    expect(new URL(callsTo(scenario, "POST", "/api/system/orders/check-account")[0]!.url()).searchParams.get("keyId")).toBe("k2");
    const confirm = orders.getByRole("button", { name: "켜기 확인" });
    await expect(confirm).toBeDisabled();
    expect(callsTo(scenario, "PUT", "/api/system/orders")).toHaveLength(0);
    await orders.getByRole("checkbox", { name: "이 계좌가 맞습니다" }).check();
    await confirm.click();

    await expect(second.getByTestId("key-order-mark")).toHaveText("주문 켜짐");
    await expect(second.getByTestId("key-account")).toHaveText("****-**47");
    await expect(first.getByTestId("key-order-mark")).toHaveText("주문 켜짐");
    expect(callsTo(scenario, "PUT", "/api/system/orders")[0]!.postDataJSON()).toEqual({ enabled: true, confirmAccountTail: "47", keyId: "k2" } satisfies OrdersSwitchInput);

    await orders.getByRole("button", { name: "주문 사용 끄기" }).click();
    await expect(second.getByTestId("key-order-mark")).toHaveText("주문 꺼짐");
    await expect(second.getByTestId("key-account")).toHaveText("****-**47");
    expect(callsTo(scenario, "PUT", "/api/system/orders")[1]!.postDataJSON()).toEqual({ enabled: false, confirmAccountTail: null, keyId: "k2" } satisfies OrdersSwitchInput);
  });

  test("주문 사용: 서버가 끝 2자리를 거절하면 오류가 그 줄에 보이고 꺼짐으로 남는다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    scenario.on(route("PUT", "/api/system/orders"), () => refusal("확인한 계좌 끝 2자리가 계좌와 다릅니다"));
    await openKiwoom(page);
    await expandKey(page, "보조");
    const orders = keyRows(page).nth(1).getByRole("region", { name: "주문 사용" });
    await orders.getByRole("button", { name: "주문 사용 켜기" }).click();
    await orders.getByRole("checkbox", { name: "이 계좌가 맞습니다" }).check();
    await orders.getByRole("button", { name: "켜기 확인" }).click();
    await expect(orders.getByRole("alert")).toContainText("확인한 계좌 끝 2자리가 계좌와 다릅니다");
    await orders.getByRole("button", { name: "취소" }).click();
    await expect(keyRows(page).nth(1).getByTestId("key-order-mark")).toHaveText("주문 꺼짐");
  });

  test("같은 계좌 거절이면 그 줄에 문구가 보이고 줄의 주문 표시는 꺼짐이다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    scenario.live.ordersAccountTails = { k2: "12" };
    scenario.live.ordersAccountRefs = { k2: "ref-k1" };
    await openKiwoom(page);
    await expandKey(page, "보조");
    const second = keyRows(page).nth(1);
    const orders = second.getByRole("region", { name: "주문 사용" });
    await orders.getByRole("button", { name: "주문 사용 켜기" }).click();
    await orders.getByRole("checkbox", { name: "이 계좌가 맞습니다" }).check();
    await orders.getByRole("button", { name: "켜기 확인" }).click();
    await expect(orders.getByRole("alert")).toHaveText("‘주계좌’와 같은 계좌입니다. 주문은 한 줄에서만 씁니다");
    await expect(orders.getByRole("button", { name: "켜기 확인" })).toHaveCount(0);
    await expect(orders.getByRole("checkbox", { name: "이 계좌가 맞습니다" })).toHaveCount(0);
    await expect(second.getByTestId("key-order-mark")).toHaveText("주문 꺼짐");
    await expect(orders.getByRole("button", { name: "주문 사용 켜기" })).toBeVisible();
  });

  test("호가주문 설정에서 계좌번호 가리기를 꺼도 시스템 설정 계좌 줄은 끝 2자리만 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    const state = scenario.documents.uiState();
    scenario.documents.saveUiState({ ...state, orderSettings: { ...scenario.documents.uiPrefs().orderSettings, maskAccount: false }, revision: state.revision + 1 } as typeof state);
    expect(scenario.documents.uiPrefs().orderSettings.maskAccount).toBe(false);
    let lookups = 0;
    scenario.on((url) => url.pathname === "/api/trading/account-number", () => { lookups += 1; return { body: { accountNumber: "1234567810" } }; });
    await openKiwoom(page);
    await expect(keyRows(page).first().getByTestId("key-account")).toHaveText("****-**12");
    await expandKey(page, "주계좌");
    await expect(keyRows(page).first()).not.toContainText("12345678");
    await expect(dialog(page)).not.toContainText("1234-5678");
    expect(lookups).toBe(0);
  });

  test("주문 사용 중인 키를 지우면 확인 문구에 호가주문창이 시세 공급원 계좌로 돌아간다고 더한다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders({ second: "on" });
    await openKiwoom(page);
    await expandKey(page, "보조");
    await keyRows(page).nth(1).getByRole("button", { name: "지우기" }).click();
    await expect(page.getByRole("dialog", { name: /‘보조’ 키를 지웁니다/ })).toContainText("주문 사용이 꺼지고, 이 계좌를 고른 호가주문창은 시세 공급원 계좌로 돌아갑니다");
  });

  test("호출 한도 카드: 줄을 표로 보이고 한도에 닿은 줄과 제한 응답이 있는 줄을 글자로도 표시한다", async ({ page, scenario }) => {
    const usage: KiwoomUsage = {
      lastMinuteStartedAt: serverSeconds(scenario) - 90,
      totalRateLimited: 3,
      trs: [
        usageTr("ka10003", { sent: 19, maxPerSecond: 5, maxWaitMs: 1050 }),
        usageTr("ka10075", { sent: 12, maxPerSecond: 1 }),
        usageTr("ka10080", { sent: 4, maxPerSecond: 3, rateLimited: 1, resent: 1 }, { totalRateLimited: 3 }),
        usageTr("ka99999", { sent: 1, maxPerSecond: 1 }),
      ],
    };
    scenario.live.kiwoomUsage = usage;
    await openKiwoom(page);
    const card = usageCard(page);
    await expect(card).toBeVisible();
    await expect(card).toContainText(/지난 1분\(\d\d:\d\d\)/);
    await expect(card.getByTestId("usage-total-limited")).toHaveText("서버를 켠 뒤 제한 응답 3건");
    await expect(card.getByRole("columnheader")).toHaveText(["TR", "1분 전송", "1초 최대", "기다림 최대", "제한 응답"]);
    const rows = card.getByRole("row");
    await expect(rows).toHaveCount(5);
    const busy = rows.filter({ hasText: "ka10003" });
    await expect(busy).toContainText("체결");
    await expect(busy).toContainText("한도에 닿음");
    await expect(busy.getByRole("cell")).toHaveText(["19", "5 / 5", "1,050ms", "0"]);
    await expect(busy).not.toHaveAttribute("data-warning", /.*/);
    await expect(rows.filter({ hasText: "ka10075" })).not.toContainText("한도에 닿음");
    const limited = rows.filter({ hasText: "ka10080" });
    await expect(limited).toHaveAttribute("data-warning", "true");
    await expect(limited).toContainText("제한 응답 있음");
    await expect(limited.getByRole("cell")).toHaveText(["4", "3 / 5", "0ms", "1"]);
    const unknown = rows.filter({ hasText: "ka99999" });
    await expect(unknown.getByRole("rowheader")).toHaveText("ka99999");
    await card.scrollIntoViewIfNeeded();
    await shot(page, "kiwoom-1440x900-usage.png");
  });

  test("호출 한도 카드: 줄이 없으면 빈 상태 문구를 보이고, 1분이 지나기 전에는 1분 뒤부터 보인다고 알린다", async ({ page, scenario }) => {
    scenario.live.kiwoomUsage = { lastMinuteStartedAt: null, totalRateLimited: 0, trs: [] };
    await openKiwoom(page);
    await expect(usageCard(page)).toContainText("1분 뒤부터 보입니다");
    await expect(usageCard(page).getByRole("table")).toHaveCount(0);
    scenario.live.kiwoomUsage = { lastMinuteStartedAt: serverSeconds(scenario), totalRateLimited: 0, trs: [] };
    await page.getByRole("tab", { name: /^일반/ }).click();
    await page.getByRole("tab", { name: /^증권사 · 계좌/ }).click();
    await expect(usageCard(page)).toContainText("지난 1분에 보낸 키움 조회가 없습니다");
    await expect(usageCard(page).getByTestId("usage-total-limited")).toHaveText("서버를 켠 뒤 제한 응답 0건");
  });

  test("호출 한도 카드: 보이는 동안 10초마다 경로를 다시 읽고 닫으면 멈춘다", async ({ page, scenario }) => {
    await page.clock.install();
    scenario.live.kiwoomUsage = { lastMinuteStartedAt: serverSeconds(scenario), totalRateLimited: 0, trs: [usageTr("ka10095", { sent: 14 })] };
    await openKiwoom(page);
    await expect(usageCard(page).getByRole("row").filter({ hasText: "ka10095" }).getByRole("cell").first()).toHaveText("14");
    const calls = () => callsTo(scenario, "GET", USAGE_PATH).length;
    const first = calls();
    expect(first).toBeGreaterThan(0);
    scenario.live.kiwoomUsage = { ...scenario.live.kiwoomUsage, trs: [usageTr("ka10095", { sent: 15 })] };
    await page.clock.runFor(9_000);
    await fixedWait(page, 300, "10초 전에는 다시 읽지 않았음을 보려면 요청이 나갈 만큼 실제 시간이 지나야 한다");
    expect(calls()).toBe(first);
    await page.clock.runFor(1_500);
    await expect.poll(calls).toBe(first + 1);
    await expect(usageCard(page).getByRole("row").filter({ hasText: "ka10095" }).getByRole("cell").first()).toHaveText("15");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await page.clock.runFor(30_000);
    await fixedWait(page, 300, "카드를 닫은 뒤 요청이 나가지 않았음을 보려면 요청이 나갈 만큼 실제 시간이 지나야 한다");
    expect(calls()).toBe(first + 1);
  });

  test("메뉴 이름이 증권사 · 계좌이고 시세 공급원 카드 → 계좌 목록 순서다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = CONNECTED_KIWOOM;
    await openKiwoom(page);
    await expect(dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ })).toHaveAttribute("aria-selected", "true");
    await expect(dialog(page).getByRole("tab", { name: /^키움 연결/ })).toHaveCount(0);
    expect(await panel(page).getByRole("region").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")))).toEqual(["시세 공급원", "계좌 목록", "호출 한도", "IP 도움"]);
  });

  test("키 둘을 더하면 키움증권 묶음에 두 줄과 2 / 5가 보이고 첫 키에 시세 표시가 있으며 응답과 화면 어디에도 시크릿이 없다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    const keys: KiwoomKey[] = [];
    const added: KiwoomKeyAdd[] = [];
    scenario.on(route("POST", KEYS), (request) => {
      const input: KiwoomKeyAdd = request.postDataJSON();
      added.push(input);
      const link = { ...CONNECTED_KIWOOM, appKeyTail: input.appKey.slice(-4) };
      keys.push(keyEntry(`k${keys.length + 1}`, input.alias, link, { market: keys.length === 0 }));
      scenario.live.kiwoomKeys = keyListOf(...keys);
      if (keys.length === 1) scenario.live.link(link);
      return { body: scenario.live.kiwoomKeys };
    });
    await openKiwoom(page);
    await expect(accounts(page)).toContainText("0 / 5");
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(accounts(page)).toContainText("토큰 받음");
    await accounts(page).getByRole("button", { name: "닫기" }).click();

    await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
    await expect(page.getByLabel("별칭", { exact: true })).toHaveValue("키움 2");
    await page.getByLabel("앱키", { exact: true }).fill(`${FAKE_APP_KEY}-second`);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장하고 연결" }).click();
    await accounts(page).getByRole("button", { name: "닫기" }).click();

    expect(added.map((input) => input.alias)).toEqual(["키움 1", "키움 2"]);
    await expect(accounts(page)).toContainText("키움증권");
    await expect(accounts(page)).toContainText("2 / 5");
    await expect(keyRows(page)).toHaveCount(2);
    await expect(keyRows(page).nth(0)).toContainText("시세");
    await expect(keyRows(page).nth(1)).not.toContainText("시세");
    const shown = (await page.content()) + (await page.locator("body").innerText());
    for (const secret of [FAKE_APP_KEY, FAKE_APP_SECRET]) {
      expect(shown).not.toContain(secret);
      expect(JSON.stringify(scenario.live.kiwoomKeys)).not.toContain(secret);
    }
  });

  test("시세 공급원 고르기에서 둘째 키를 고르면 확인 뒤에만 시세 키 지정 요청이 나가고 시세 표시가 옮겨 간다. 취소하면 요청이 없다", async ({ page, scenario }) => {
    const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
    const second = keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" });
    scenario.live.kiwoomKeys = keyListOf(first, second);
    const designated: KiwoomMarketKeyInput[] = [];
    scenario.on(route("PUT", "/api/system/kiwoom/market-key"), (request) => {
      designated.push(request.postDataJSON());
      scenario.live.kiwoomKeys = keyListOf({ ...first, market: false }, { ...second, market: true });
      scenario.live.link(second.link);
      return { body: scenario.live.kiwoomKeys };
    });
    await openKiwoom(page);
    const picker = marketCard(page).getByRole("combobox", { name: "시세 키" });
    await expect(picker).toHaveValue("k1");
    await picker.selectOption("k2");
    const confirmation = page.getByRole("dialog", { name: /시세를 ‘보조’에서 받습니다/ });
    await expect(confirmation).toContainText("열린 차트·호가·체결을 새로 받습니다");
    await expect(confirmation).toContainText("주문 계좌는 바뀌지 않습니다");
    await confirmation.getByRole("button", { name: "취소" }).click();
    expect(designated).toEqual([]);
    await expect(picker).toHaveValue("k1");

    await picker.selectOption("k2");
    await page.getByRole("dialog", { name: /시세를 ‘보조’에서 받습니다/ }).getByRole("button", { name: "시세 바꾸기" }).click();
    await pollSaved(() => designated).toEqual([{ keyId: "k2" }]);
    await expect(picker).toHaveValue("k2");
    await expect(keyRows(page).filter({ hasText: "보조" })).toContainText("시세");
    await expect(keyRows(page).filter({ hasText: "주계좌" })).not.toContainText("시세");
  });

  test("5개면 더하기 단추 대신 상한 안내가 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = keyListOf(...[1, 2, 3, 4, 5].map((n) => keyEntry(`k${n}`, `키 ${n}`, CONNECTED_KIWOOM, { market: n === 1 })));
    await openKiwoom(page);
    await expect(accounts(page)).toContainText("5 / 5");
    await expect(accounts(page)).toContainText("키는 5개까지입니다");
    await expect(accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" })).toHaveCount(0);
  });

  test("같은 앱키·빈 별칭이면 서버 문구를 보이고 입력이 남는다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }));
    let message = "이미 등록한 앱키입니다";
    scenario.on(route("POST", KEYS), () => refusal(message));
    await openKiwoom(page);
    await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
    const form = accounts(page).getByRole("form", { name: "키 더하기" });
    await form.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await form.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await form.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(form.getByRole("alert")).toHaveText("이미 등록한 앱키입니다");
    await expect(form.getByLabel("앱키", { exact: true })).toHaveValue(FAKE_APP_KEY);
    await expect(form.getByLabel("시크릿", { exact: true })).toHaveValue(FAKE_APP_SECRET);

    message = "별칭이 비어 있습니다";
    await form.getByLabel("별칭", { exact: true }).fill("");
    await form.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(form.getByRole("alert")).toHaveText("별칭이 비어 있습니다");
    await expect(form.getByLabel("앱키", { exact: true })).toHaveValue(FAKE_APP_KEY);
    expect(callsTo(scenario, "POST", KEYS)).toHaveLength(2);
  });

  test("바꾸기에서 별칭만 고치면 별칭 바꾸기 요청만 나간다", async ({ page, scenario }) => {
    const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
    const second = keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" });
    scenario.live.kiwoomKeys = keyListOf(first, second);
    const renamed: KiwoomKeyAlias[] = [];
    scenario.on(route("PUT", `${KEYS}/k2/alias`), (request) => {
      renamed.push(request.postDataJSON());
      scenario.live.kiwoomKeys = keyListOf(first, { ...second, alias: renamed.at(-1)!.alias });
      return { body: scenario.live.kiwoomKeys };
    });
    await openKiwoom(page);
    await expandKey(page, "보조");
    await panel(page).getByRole("button", { name: "별칭·키 바꾸기" }).click();
    const form = accounts(page).getByRole("form", { name: "키 바꾸기" });
    await expect(form.getByLabel("별칭", { exact: true })).toHaveValue("보조");
    await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await form.getByLabel("별칭", { exact: true }).fill("새 이름");
    await form.getByRole("button", { name: "저장", exact: true }).click();
    await expect(keyRows(page).filter({ hasText: "새 이름" })).toHaveCount(1);
    expect(renamed).toEqual([{ alias: "새 이름" }]);
    expect(callsTo(scenario, "PUT", `${KEYS}/k2/key`)).toHaveLength(0);
  });

  test("지우기는 확인 뒤에만 요청이 나가고 시세 키를 지울 때 확인 문구가 다음 시세 키를 말한다", async ({ page, scenario }) => {
    const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
    const second = keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" });
    scenario.live.kiwoomKeys = keyListOf(first, second);
    scenario.on(route("DELETE", `${KEYS}/k1`), () => {
      scenario.live.kiwoomKeys = keyListOf({ ...second, market: true });
      scenario.live.link(second.link);
      return { body: scenario.live.kiwoomKeys };
    });
    await openKiwoom(page);
    await expandKey(page, "주계좌");
    await panel(page).getByRole("button", { name: "지우기" }).click();
    const confirmation = page.getByRole("dialog", { name: /‘주계좌’는 시세 키입니다/ });
    await expect(confirmation).toContainText("시세를 ‘보조’에서 받습니다");
    await confirmation.getByRole("button", { name: "취소" }).click();
    expect(callsTo(scenario, "DELETE", `${KEYS}/k1`)).toHaveLength(0);
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: /‘주계좌’는 시세 키입니다/ }).getByRole("button", { name: "키 지우기" }).click();
    await expect(keyRows(page)).toHaveCount(1);
    await expect(keyRows(page).first()).toContainText("시세");
    expect(callsTo(scenario, "DELETE", `${KEYS}/k1`)).toHaveLength(1);

    await expandKey(page, "보조");
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await expect(page.getByRole("dialog", { name: /‘보조’는 시세 키입니다. 지우면 키가 없어/ })).toBeVisible();
  });

  test("다른 키가 8050으로 막히면 그 줄에만 오류가 보이고 메뉴 점이 노랑이며, 두 확인을 고른 뒤에만 그 줄의 다시 연결이 그 키 연결 요청을 보낸다. 시세 공급원 카드는 시세 키를 보인다", async ({ page, scenario }) => {
    const blocked = failed("authBlocked8050", null, BLOCKED_MESSAGE, { needsAcknowledgement: true, appKeyTail: "5678" });
    const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
    const second = keyEntry("k2", "보조", blocked);
    scenario.live.kiwoomKeys = keyListOf(first, second);
    const connect = scenario.hold(route("POST", `${KEYS}/k2/connect`));
    await openKiwoom(page);
    await expect(dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ }).locator(".conn-dot")).toHaveAttribute("data-tone", "amber");
    await expect(marketCard(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
    await expect(marketCard(page).getByRole("combobox", { name: "시세 키" })).toHaveValue("k1");
    await expect(keyRows(page).filter({ hasText: "보조" })).toContainText("8050 인증 차단");
    await expect(keyRows(page).filter({ hasText: "주계좌" })).not.toContainText("8050");

    await expandKey(page, "보조");
    const reconnect = accounts(page).getByRole("button", { name: /^다시 연결/ });
    await expect(reconnect).toBeDisabled();
    await accounts(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
    await expect(reconnect).toBeDisabled();
    await accounts(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다").check();
    await expect(reconnect).toBeEnabled();
    expect(callsTo(scenario, "POST", `${KEYS}/k2/connect`)).toHaveLength(0);
    await reconnect.click();
    await connect.received;
    expect(callsTo(scenario, "POST", `${KEYS}/k2/connect`)[0]!.postDataJSON()).toEqual({ acknowledged: true } satisfies KiwoomConnectInput);
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);
    scenario.live.kiwoomKeys = keyListOf(first, { ...second, link: { ...blocked, state: "connected", problem: null, needsAcknowledgement: false } });
    connect.reply({ body: scenario.live.kiwoomKeys });
    await expect(keyRows(page).filter({ hasText: "보조" })).not.toContainText("8050");
    await expect(dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ }).locator(".conn-dot")).toHaveAttribute("data-tone", "mint");
  });
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("8050 화면과 키 폼이 가로 스크롤 없이 들어간다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", serverSeconds(scenario) + 570, BLOCKED_MESSAGE, { needsAcknowledgement: true, registeredIp: { ip: "2001:db8:aaaa:bbbb:cccc:dddd:eeee:fff0", at: serverSeconds(scenario) } });
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", checkedAt: serverSeconds(scenario) } satisfies PublicIpCheck }));
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toBeVisible();
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ }).click();
    await expect(panel(page)).toContainText(BLOCKED_MESSAGE);
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page).getByRole("alert")).toBeVisible();
    await expandKey(page, "키 1");
    await panel(page).getByRole("button", { name: "별칭·키 바꾸기" }).click();
    const overflow = () => page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, content: Math.max(...[...document.querySelectorAll('[role="tabpanel"] *')].map((el) => el.getBoundingClientRect().right)) - innerWidth }));
    const sizes = await overflow();
    expect(sizes.page).toBe(0);
    expect(sizes.content).toBeLessThanOrEqual(0);
    await shot(page, "kiwoom-360x800-blocked-8050.png");
  });
});
