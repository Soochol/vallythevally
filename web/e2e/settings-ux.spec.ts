import type { Page } from "@playwright/test";
import type { KiwoomKeyAdd } from "../src/api/generated/KiwoomKeyAdd";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { KiwoomUsage } from "../src/api/generated/KiwoomUsage";
import type { OrdersStatus } from "../src/api/generated/OrdersStatus";
import { cell, expect, fixedWait, test, type Scenario } from "./harness";
import { CONNECTED_KIWOOM, keyEntry, keyListOf } from "./fixtures/scenario";

const FAKE_APP_KEY = "FAKEAPPKEYabcdefgh7Z2D";
const FAKE_APP_SECRET = "FAKESECRETvalue0123456789xyz";
const KEYS = "/api/system/kiwoom/keys";
const BLOCKED_MESSAGE = "키움이 지정단말기 인증을 거절했습니다(8050). 고친 뒤 아래에서 다시 연결하세요. 서버를 다시 켤 필요는 없습니다";

const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다", realtimeRegistered: null, symbolCount: null };
const DISCONNECTED: KiwoomLinkStatus = { ...NO_KEY, keySource: "file", appKeyTail: "7Z2D", state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다" };
const BLOCKED: KiwoomLinkStatus = { ...DISCONNECTED, state: "failed", problem: "authBlocked8050", retryAt: null, message: BLOCKED_MESSAGE, needsAcknowledgement: true };

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const panel = (page: Page) => dialog(page).getByRole("tabpanel");
const accounts = (page: Page) => panel(page).getByRole("region", { name: "계좌 목록" });
const keyRows = (page: Page) => accounts(page).getByRole("listitem");
const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);
const refusal = (message: string) => ({ status: 400, body: { error: { code: "bad_request", message, reason: null, retryAt: null, manualActionRequired: false } } });
const chooseBroker = (page: Page, name: "키움증권" | "한국투자증권") => accounts(page).getByRole("group", { name: "증권사 고르기" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
const twoKeys = () => keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }), keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" }));
const twoOrders = (): OrdersStatus => ({
  state: "on", accountRef: "ref-k1", accountTail: "12", message: "주문 사용이 켜져 있습니다",
  accounts: [
    { keyId: "k1", broker: "kiwoom", alias: "주계좌", market: true, state: "on", accountRef: "ref-k1", accountTail: "12" },
    { keyId: "k2", broker: "kiwoom", alias: "보조", market: false, state: "off", accountRef: null, accountTail: null },
  ],
});
const heightOf = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!.height;
const expandKey = (page: Page, alias: string) => accounts(page).getByRole("button", { name: alias, exact: false }).first().click();

async function openKiwoom(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  if (await panel(page).count() === 0) await dialog(page).getByRole("tab", { name: /^증권사 · 계좌/ }).click();
  await expect(panel(page)).toBeVisible();
}

test.describe("390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("키 입력 폼의 별칭·앱키·시크릿 칸은 높이가 36px 이상이다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    await openKiwoom(page);
    await chooseBroker(page, "키움증권");
    for (const label of ["별칭", "앱키", "시크릿"]) {
      expect(await heightOf(page.getByLabel(label, { exact: true })), label).toBeGreaterThanOrEqual(36);
    }
  });

  test("시세 공급원 고르기의 높이는 36px 이상이다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    await openKiwoom(page);
    const picker = panel(page).getByRole("region", { name: "시세 공급원" }).getByRole("combobox", { name: "시세 키" });
    expect(await heightOf(picker)).toBeGreaterThanOrEqual(36);
  });
});

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("설정 대화상자 안 버튼의 글자는 본문보다 작지 않고 연결 끊기에는 테두리나 면이 있다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    await openKiwoom(page);
    await expandKey(page, "보조");
    const disconnect = panel(page).getByRole("button", { name: "연결 끊기" }).first();
    await expect(disconnect).toBeVisible();
    const sizes = await dialog(page).evaluate((root) => {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const buttons = [...root.querySelectorAll<HTMLElement>("button, a.btn")].filter((el) => el.getClientRects().length > 0);
      return { body, smallest: Math.min(...buttons.map((el) => parseFloat(getComputedStyle(el).fontSize))), count: buttons.length };
    });
    expect(sizes.count).toBeGreaterThan(5);
    expect(sizes.smallest).toBeGreaterThanOrEqual(sizes.body);
    const look = await disconnect.evaluate((el) => {
      const style = getComputedStyle(el);
      return { border: parseFloat(style.borderTopWidth), background: style.backgroundColor };
    });
    expect(look.border > 0 || look.background !== "rgba(0, 0, 0, 0)").toBe(true);
  });

  test("키가 없으면 키움에 연결 버튼 없이 세 걸음 안내와 증권사 카드가 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    await openKiwoom(page);
    await expect(panel(page).getByRole("button", { name: "키움에 연결" })).toHaveCount(0);
    const steps = panel(page).getByRole("list", { name: "처음 연결하는 순서" }).getByRole("listitem");
    await expect(steps).toHaveText(["1포털에서 앱키 받기", "2공인 IP 등록", "3여기에 붙여넣기"]);
    const brokers = accounts(page).getByRole("group", { name: "증권사 고르기" }).getByRole("button");
    await expect(brokers).toHaveCount(2);
    await expect(brokers.nth(0)).toContainText("남은 자리 5개");
    await expect(brokers.nth(1)).toContainText("한국투자증권");
  });

  test("이미 등록한 앱키를 저장하면 앱키 칸이 오류로 표시되고 문장이 그 칸 아래에 있다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = keyListOf(keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true }));
    scenario.on(route("POST", KEYS), () => refusal("이미 등록한 앱키입니다"));
    await openKiwoom(page);
    await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
    await chooseBroker(page, "키움증권");
    const form = accounts(page).getByRole("form", { name: "키 더하기" });
    const appKey = form.getByLabel("앱키", { exact: true });
    await appKey.fill(FAKE_APP_KEY);
    await form.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await form.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(appKey).toHaveAttribute("aria-invalid", "true");
    const message = form.locator(".ui-field-error");
    await expect(message).toHaveText("이미 등록한 앱키입니다");
    await expect(form.getByLabel("시크릿", { exact: true })).not.toHaveAttribute("aria-invalid", "true");
    const [input, error] = [await appKey.boundingBox(), await message.boundingBox()];
    expect(error!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
    expect(await appKey.getAttribute("aria-describedby")).toContain((await message.getAttribute("id"))!);
  });

  test("8050으로 막히면 스크롤하기 전 첫 화면에 내 공인 IP 확인이 보인다", async ({ page, scenario }) => {
    scenario.live.kiwoomLink = BLOCKED;
    await openKiwoom(page);
    const check = panel(page).getByRole("button", { name: "내 공인 IP 확인" });
    await expect(check).toBeVisible();
    const scroller = panel(page).locator("div.overflow-y-auto");
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    const [view, button] = [(await scroller.boundingBox())!, (await check.boundingBox())!];
    expect(button.y).toBeGreaterThanOrEqual(view.y);
    expect(button.y + button.height).toBeLessThanOrEqual(view.y + view.height);
  });

  test("주문 사용을 켜려면 실제 체결 경고와 계좌 확인을 거치고 켜는 버튼은 저장 버튼과 색이 다르다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    scenario.live.ordersAccountTails = { k2: "47" };
    await openKiwoom(page);
    await expandKey(page, "보조");
    const row = keyRows(page).nth(1);
    await row.getByRole("button", { name: "별칭·키 바꾸기" }).click();
    await row.getByLabel("별칭", { exact: true }).fill("새 이름");
    const save = row.getByRole("button", { name: "저장", exact: true });
    await expect(save).toBeEnabled();
    const orders = row.getByTestId("key-orders");
    const orderSwitch = orders.getByRole("switch", { name: "주문 사용" });
    await orderSwitch.click();
    await expect(orders).toContainText("실제 체결");
    await expect(orderSwitch).toHaveAttribute("aria-checked", "false");
    const enable = orders.getByRole("button", { name: "실전 주문 켜기" });
    await expect(enable).toBeDisabled();
    expect(callsTo(scenario, "PUT", "/api/system/orders")).toHaveLength(0);
    await orders.getByRole("checkbox", { name: "이 계좌가 맞습니다" }).check();
    await expect(enable).toBeEnabled();
    const [enableColor, saveColor] = await Promise.all([enable, save].map((button) => button.evaluate((el) => getComputedStyle(el).backgroundColor)));
    expect(enableColor).not.toBe(saveColor);
    expect(callsTo(scenario, "PUT", "/api/system/orders")).toHaveLength(0);
    await enable.click();
    await expect(orderSwitch).toHaveAttribute("aria-checked", "true");
    expect(callsTo(scenario, "PUT", "/api/system/orders")).toHaveLength(1);
  });

  test("설정 대화상자에는 브라우저 기본 select가 없다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    await openKiwoom(page);
    await expandKey(page, "보조");
    await expect(panel(page).getByRole("combobox", { name: "시세 키" })).toBeVisible();
    await expect(dialog(page).locator("select")).toHaveCount(0);
    for (const name of ["일반", "단축키", "데이터 · 저장소"]) {
      await dialog(page).getByRole("tab", { name: new RegExp(`^${name}`) }).click();
      await expect(panel(page)).toBeVisible();
      await expect(dialog(page).locator("select")).toHaveCount(0);
    }
  });

  test("연결된 평소 상태에서는 2초가 지나도 설정 내용 칸의 DOM이 바뀌지 않는다", async ({ page, scenario }) => {
    await page.clock.install();
    scenario.live.kiwoomKeys = twoKeys();
    scenario.live.orders = twoOrders();
    const usage: KiwoomUsage = { lastMinuteStartedAt: Math.floor(scenario.now / 1000), totalRateLimited: 0, trs: [] };
    scenario.live.kiwoomUsage = usage;
    await openKiwoom(page);
    await expect(panel(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
    await expect(keyRows(page)).toHaveCount(2);
    await fixedWait(page, 300, "처음 불러오기가 끝나 내용이 가라앉도록 실제 시간이 지나야 한다");
    await panel(page).evaluate((root) => {
      const counter = window as unknown as { settingsMutations: number };
      counter.settingsMutations = 0;
      new MutationObserver((records) => { counter.settingsMutations += records.length; }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.clock.runFor(2000);
    await fixedWait(page, 300, "시계를 넘긴 뒤 늦게 오는 그리기까지 잡으려면 실제 시간이 지나야 한다");
    expect(await page.evaluate(() => (window as unknown as { settingsMutations: number }).settingsMutations)).toBe(0);
  });

  test("키 삭제 확인창은 제목과 결과 목록이 따로 있다", async ({ page, scenario }) => {
    scenario.live.kiwoomKeys = twoKeys();
    await openKiwoom(page);
    await expandKey(page, "주계좌");
    await keyRows(page).first().getByRole("button", { name: "지우기" }).click();
    const confirmation = page.getByRole("dialog", { name: "‘주계좌’ 키를 지웁니다" });
    await expect(confirmation.getByRole("heading", { name: "‘주계좌’ 키를 지웁니다" })).toBeVisible();
    await expect(confirmation.getByRole("list").getByRole("listitem")).toHaveText(["시세 키입니다. 지우면 시세를 ‘보조’에서 받습니다"]);
    await confirmation.getByRole("button", { name: "취소" }).click();
    await expect(confirmation).toHaveCount(0);
  });

  test("키를 저장해도 화면·저장소·주소·요청 주소에 시크릿이 남지 않는다", async ({ page, scenario }) => {
    const consoleText: string[] = [];
    page.on("console", (message) => consoleText.push(message.text()));
    scenario.live.kiwoomLink = NO_KEY;
    const saved: KiwoomKeyAdd[] = [];
    scenario.on(route("POST", KEYS), (request) => {
      saved.push(request.postDataJSON());
      scenario.live.link(DISCONNECTED);
      return { body: keyListOf(keyEntry("k1", "키 1", DISCONNECTED, { market: true })) };
    });
    await openKiwoom(page);
    await chooseBroker(page, "키움증권");
    await page.getByLabel("앱키", { exact: true }).fill(` ${FAKE_APP_KEY} `);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_APP_SECRET);
    await page.getByRole("button", { name: "보기", exact: true }).first().click();
    await page.getByRole("button", { name: "저장하고 연결" }).click();
    await expect(accounts(page).getByRole("button", { name: "닫기" })).toBeVisible();
    expect(saved).toEqual([{ alias: "키움 1", appKey: FAKE_APP_KEY, appSecret: FAKE_APP_SECRET }]);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    const visible = await page.locator("body").innerText();
    const html = await page.content();
    for (const secret of [FAKE_APP_KEY, FAKE_APP_SECRET]) {
      expect(visible).not.toContain(secret);
      expect(html).not.toContain(secret);
      expect(storage).not.toContain(secret);
      expect(page.url()).not.toContain(secret);
      expect(consoleText.join("\n")).not.toContain(secret);
      for (const request of scenario.requests) expect(decodeURIComponent(request.url())).not.toContain(secret);
    }
  });
});
