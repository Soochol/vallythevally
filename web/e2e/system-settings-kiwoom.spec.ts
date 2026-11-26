import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { KisAccountListing } from "../src/api/generated/KisAccountListing";
import type { KiwoomConnectInput } from "../src/api/generated/KiwoomConnectInput";
import type { KiwoomKey } from "../src/api/generated/KiwoomKey";
import type { KiwoomKeyAdd } from "../src/api/generated/KiwoomKeyAdd";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { OrdersAccount } from "../src/api/generated/OrdersAccount";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import { cell, expect, test, type Scenario } from "./harness";
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

const KEYS = "/api/system/kiwoom/keys";
const accounts = (page: Page) => panel(page).getByRole("region", { name: "계좌 목록" });
const chooseBroker = (page: Page, name: "키움증권" | "한국투자증권") => accounts(page).getByRole("group", { name: "증권사 고르기" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
const keyRows = (page: Page) => accounts(page).getByRole("listitem");
const expandKey = (page: Page, alias: string) => accounts(page).getByRole("button", { name: alias, exact: false }).first().click();
const singleKey = (link: KiwoomLinkStatus) => keyListOf(keyEntry("k1", "키 1", link, { market: true }));
const twoKeys = () => keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }), keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" }));

async function openKiwoom(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  if (await panel(page).count() === 0) await dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function shot(page: Page, name: string) {
  if (process.env.VALLY_E2E_SCREENSHOTS !== "1") return;
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, name) });
}

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("키 없음 → 키 저장 → 연결 → 연결됨 핵심 흐름과 시크릿 비노출", async ({ page, scenario }) => {
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
    await chooseBroker(page, "키움증권");
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "저장하고 연결" }).click();

    await expect(accounts(page).getByRole("button", { name: "닫기" })).toBeVisible();
    expect(saved).toEqual([{ alias: "키움 1", appKey: FAKE_APP_KEY, appSecret: FAKE_APP_SECRET }]);
    for (const request of scenario.requests) {
      for (const secret of [FAKE_APP_KEY, FAKE_APP_SECRET]) {
        expect(decodeURIComponent(request.url())).not.toContain(secret);
        expect(JSON.stringify(await request.allHeaders())).not.toContain(secret);
      }
    }

    await panel(page).getByRole("button", { name: "키움에 연결" }).dblclick();
    await connect.received;
    const connected: KiwoomLinkStatus = { ...DISCONNECTED, state: "connected", message: "키움에 연결됨", tokenExpiresAt: serverSeconds(scenario) + 86_400, realtimeRegistered: 3, symbolCount: 2812 };
    scenario.live.link(connected);
    connect.reply({ body: connected });
    await expect(panel(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
    expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(1);
    expect(scenario.requests.find((r) => new URL(r.url()).pathname === "/api/system/kiwoom/connect")!.postDataJSON()).toEqual({ acknowledged: false } satisfies KiwoomConnectInput);
    await shot(page, "kiwoom-1440x900-connected.png");
  });

  test("한투 계좌 추가 시 잔고 확인과 주문 사용 켜기로 바로 이동", async ({ page, scenario }) => {
    const kiwoomKey = () => keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
    const kisKey = (patch: Partial<KiwoomKey> = {}, link: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, appKeyTail: "KIS1" }) => keyEntry("kis1", "한투 1", link, { broker: "kis", ...patch });
    const ACCOUNT_NO = "50012356-01";
    const listingOf = (patch: Partial<KisAccountListing> = {}): KisAccountListing => ({ accountTail: "34", accountMasked: "****-**34", htsIdSet: true, source: "file", ...patch });

    scenario.live.kiwoomKeys = keyListOf(kiwoomKey());
    scenario.live.ordersAccountTails["kis1"] = "56";
    scenario.on(route("POST", KEYS), (request) => {
      const input: KiwoomKeyAdd = request.postDataJSON();
      scenario.live.kiwoomKeys = keyListOf(kiwoomKey(), kisKey({ alias: input.alias, kisAccount: listingOf({ accountTail: "56", accountMasked: "****-**56", htsIdSet: false }) }, { ...CONNECTED_KIWOOM, appKeyTail: input.appKey.slice(-4) }));
      scenario.live.orders = {
        state: "on", accountRef: "ref-k1", accountTail: "12", message: "주문 사용이 켜져 있습니다", accounts: [
          { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: "ref-k1", accountTail: "12" },
          { keyId: "kis1", broker: "kis", alias: "한투 1", market: false, state: "off", accountRef: null, accountTail: "56" } satisfies OrdersAccount,
        ],
      };
      return { body: scenario.live.kiwoomKeys };
    });

    await openKiwoom(page);
    await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
    await chooseBroker(page, "한국투자증권");
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_APP_KEY);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByLabel("계좌번호", { exact: true }).fill(ACCOUNT_NO);
    await page.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(accounts(page).getByTestId("kis-account-check")).toHaveText("계좌 ****-**56 잔고 조회가 됐습니다");
    await accounts(page).getByRole("button", { name: "주문 사용 켜기로" }).click();
    await expect(keyRows(page).filter({ hasText: "한투 1" }).getByTestId("key-orders").getByRole("switch", { name: "주문 사용" })).toBeEnabled();
  });
});

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("모바일 키 입력 칸과 시세 선택 콤보박스의 높이는 36px 이상이다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    await openKiwoom(page);
    const picker = panel(page).getByRole("region", { name: "시세 공급원" }).getByRole("combobox", { name: "시세 키" });
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
    await chooseBroker(page, "키움증권");
    for (const label of ["별칭", "앱키", "시크릿"]) {
      expect((await page.getByLabel(label, { exact: true }).boundingBox())!.height, label).toBeGreaterThanOrEqual(36);
    }
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
    const sizes = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - innerWidth,
      content: Math.max(...[...document.querySelectorAll('[role="tabpanel"] *')].map((el) => el.getBoundingClientRect().right)) - innerWidth,
    }));
    expect(sizes.page).toBe(0);
    expect(sizes.content).toBeLessThanOrEqual(0);
    await shot(page, "kiwoom-360x800-blocked-8050.png");
  });
});
