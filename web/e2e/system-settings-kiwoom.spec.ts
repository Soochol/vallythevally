import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { KiwoomConnectInput } from "../src/api/generated/KiwoomConnectInput";
import type { KiwoomKeyInput } from "../src/api/generated/KiwoomKeyInput";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import type { RegisteredIpInput } from "../src/api/generated/RegisteredIpInput";
import { cell, expect, test, type Scenario } from "./harness";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";

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
    const saved: KiwoomKeyInput[] = [];
    scenario.on(route("PUT", "/api/system/kiwoom/key"), (request) => {
      saved.push(request.postDataJSON());
      scenario.live.link(DISCONNECTED);
      return { body: DISCONNECTED };
    });
    const connect = scenario.hold(route("POST", "/api/system/kiwoom/connect"));

    await openKiwoom(page);
    await expect(panel(page)).toContainText("키 없음");
    await expect(panel(page).getByRole("button", { name: "키움에 연결" })).toBeDisabled();
    await expect(panel(page)).toContainText("키를 저장해도 키움에는 아무것도 보내지 않습니다");
    await expect(panel(page)).toContainText("키움 REST · api.kiwoom.com (고정)");
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("type", "password");
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("autocomplete", "off");
    await shot(page, "kiwoom-1440x900-no-key.png");

    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "입력 보기" }).click();
    await expect(page.getByLabel("앱키", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "저장" }).click();

    await expect(panel(page).getByRole("button", { name: "바꾸기" })).toBeVisible();
    expect(saved).toEqual([{ appKey: FAKE_APP_KEY, appSecret: FAKE_APP_SECRET }]);
    await expect(panel(page)).toContainText("••••••••••••7Z2D");
    await expect(panel(page)).toContainText("저장됨 · 다시 볼 수 없음");
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
    const [put] = callsTo(scenario, "PUT", "/api/system/kiwoom/key");
    expect(new URL(put!.url()).search).toBe("");
    expect(await put!.headerValue("content-type")).toContain("application/json");

    await panel(page).getByRole("button", { name: "키움에 연결" }).dblclick();
    await connect.received;
    scenario.live.link({ ...DISCONNECTED, state: "connecting", step: "token", message: "키움에 연결하는 중입니다" });
    await expect(panel(page).getByRole("heading", { name: "연결 중" })).toBeVisible();
    await expect(panel(page).getByRole("listitem").filter({ hasText: "2. 토큰" })).toHaveAttribute("aria-current", "step");
    await expect(panel(page).getByRole("button", { name: /취소/ })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "바꾸기" })).toBeDisabled();

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

  test("키를 지우기 전에 확인을 받고 확인하면 지운다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = DISCONNECTED;
    scenario.on(route("DELETE", "/api/system/kiwoom/key"), () => { scenario.live.link(NO_KEY); return { body: NO_KEY }; });
    await openKiwoom(page);
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: "저장한 키움 키를 지웁니다" }).getByRole("button", { name: "취소" }).click();
    expect(callsTo(scenario, "DELETE", "/api/system/kiwoom/key")).toHaveLength(0);
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: "저장한 키움 키를 지웁니다" }).getByRole("button", { name: "키 지우기" }).click();
    await expect(panel(page).getByRole("heading", { name: "키 없음" })).toBeVisible();
    const deletes = callsTo(scenario, "DELETE", "/api/system/kiwoom/key");
    expect(deletes).toHaveLength(1);
    expect(await deletes[0]!.headerValue("content-type")).toContain("application/json");
  });

  test("저장하고 지워 키 없음으로 돌아오면 입력칸은 비어 있다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    scenario.on(route("PUT", "/api/system/kiwoom/key"), () => { scenario.live.link(DISCONNECTED); return { body: DISCONNECTED }; });
    scenario.on(route("DELETE", "/api/system/kiwoom/key"), () => { scenario.live.link(NO_KEY); return { body: NO_KEY }; });
    await openKiwoom(page);
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장" }).click();
    await panel(page).getByRole("button", { name: "지우기" }).click();
    await page.getByRole("dialog", { name: "저장한 키움 키를 지웁니다" }).getByRole("button", { name: "키 지우기" }).click();
    await expect(page.getByLabel("앱키", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("시크릿", { exact: true })).toHaveValue("");
  });

  test("환경 키면 폼이 막히고 배지와 가린 값만 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = { ...DISCONNECTED, keySource: "env", appKeyTail: "ENV4" };
    await openKiwoom(page);
    await expect(panel(page)).toContainText(".env에서 읽음 · 읽기 전용");
    await expect(panel(page)).toContainText("••••••••••••ENV4");
    await expect(panel(page).getByRole("button", { name: "바꾸기" })).toHaveCount(0);
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
    await expect.poll(() => registered).toEqual([{ ip: "203.0.113.7" }]);
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
      if (bodies.length === 1) { scenario.live.link(waiting); return { body: waiting }; }
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
    await expect.poll(() => bodies).toEqual([{ acknowledged: true }, { acknowledged: true }]);
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
    await openKiwoom(page);
    const reconnect = panel(page).getByRole("button", { name: /^다시 연결/ });
    await expect(panel(page)).toContainText("다음 발급 가능");
    await expect(reconnect).toBeDisabled();
    await expect(reconnect).toContainText("뒤 가능");
    await shot(page, "kiwoom-1440x900-interval-wait.png");
    await expect(reconnect).toBeEnabled({ timeout: 8000 });
    await expect(reconnect).toHaveText("다시 연결");
    await expect(panel(page)).toContainText("지금 연결할 수 있습니다");
    await page.waitForTimeout(1500);
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
    await expect(panel(page).getByRole("button", { name: /연결/ })).toHaveCount(0);
  });

  test("8050이 아닌 인증 차단은 키 확인 한 문장과 키 바꾸기를 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("keyNeedsCheck", null, "키움 인증에 실패했습니다");
    await openKiwoom(page);
    await expect(panel(page)).toContainText("앱키·시크릿을 확인하세요");
    await expect(panel(page).getByRole("button", { name: "바꾸기" })).toBeEnabled();
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
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("8050 화면과 키 폼이 가로 스크롤 없이 들어간다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = failed("authBlocked8050", serverSeconds(scenario) + 570, BLOCKED_MESSAGE, { needsAcknowledgement: true, registeredIp: { ip: "2001:db8:aaaa:bbbb:cccc:dddd:eeee:fff0", at: serverSeconds(scenario) } });
    scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "2001:db8:aaaa:bbbb:cccc:dddd:eeee:ffff", checkedAt: serverSeconds(scenario) } satisfies PublicIpCheck }));
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toBeVisible();
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await dialog(page).getByRole("tab", { name: /^키움 연결/ }).click();
    await expect(panel(page)).toContainText(BLOCKED_MESSAGE);
    await panel(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
    await expect(panel(page).getByRole("alert")).toBeVisible();
    await panel(page).getByRole("button", { name: "바꾸기" }).click();
    const overflow = () => page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth, content: Math.max(...[...document.querySelectorAll('[role="tabpanel"] *')].map((el) => el.getBoundingClientRect().right)) - innerWidth }));
    const sizes = await overflow();
    expect(sizes.page).toBe(0);
    expect(sizes.content).toBeLessThanOrEqual(0);
    await shot(page, "kiwoom-360x800-blocked-8050.png");
  });
});
