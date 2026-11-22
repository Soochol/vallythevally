import type { Page, Request } from "@playwright/test";
import type { KiwoomKeyList } from "../src/api/generated/KiwoomKeyList";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import { cell, expect, pollSaved, test, type Scenario } from "./harness";
import { CONNECTED_KIWOOM, keyEntry, keyListOf } from "./fixtures/scenario";

const KEYS = "/api/system/kiwoom/keys";
const BLOCKED_MESSAGE = "키움이 지정단말기 인증을 거절했습니다(8050)";
const IP_CONFIRMATION = "포털에 지금 공인 IP를 등록했습니다";
const LOCK_CONFIRMATION = "반복 발급 잠금이 풀렸는지 확인했습니다";

const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const panel = (page: Page) => dialog(page).getByRole("tabpanel");
const accounts = (page: Page) => panel(page).getByRole("region", { name: "계좌 목록" });
const keyRows = (page: Page) => accounts(page).getByRole("listitem");
const reconnect = (page: Page) => accounts(page).getByRole("button", { name: /^다시 연결/ });
const expandKey = (page: Page, alias: string) => accounts(page).getByRole("button", { name: alias }).first().click();
const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const keyGets = (scenario: Scenario) => scenario.requests.filter((r) => r.method() === "GET" && new URL(r.url()).pathname === KEYS);
const blocked = (tail: string): KiwoomLinkStatus => ({ ...CONNECTED_KIWOOM, state: "failed", problem: "authBlocked8050", retryAt: null, needsAcknowledgement: true, message: BLOCKED_MESSAGE, appKeyTail: tail });

async function openKiwoom(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

function holdNextKeyGet(scenario: Scenario) {
  let armed = true;
  let received: (request: Request) => void = () => {};
  let release: (body: KiwoomKeyList) => void = () => {};
  const request = new Promise<Request>((resolve) => { received = resolve; });
  const reply = new Promise<KiwoomKeyList>((resolve) => { release = resolve; });
  scenario.on(route("GET", KEYS), async (input) => {
    if (!armed) return { body: scenario.live.kiwoomKeys };
    armed = false;
    received(input);
    return { body: await reply };
  });
  return { received: request, release };
}

async function watchAccounts(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as { seen: { minRows: number; maxRows: number; resultGone: boolean } };
    const section = () => document.querySelector('section[aria-label="계좌 목록"]');
    const rows = () => section()?.querySelectorAll("li").length ?? 0;
    target.seen = { minRows: rows(), maxRows: rows(), resultGone: false };
    new MutationObserver(() => {
      target.seen.minRows = Math.min(target.seen.minRows, rows());
      target.seen.maxRows = Math.max(target.seen.maxRows, rows());
      if (!section()?.textContent?.includes("토큰 받음")) target.seen.resultGone = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { seen: { minRows: number; maxRows: number; resultGone: boolean } }).seen);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("시세 키가 아닌 키를 지운 뒤 지우기 전에 나간 목록 폴링 응답이 늦게 와도 지운 줄이 되살아나지 않는다", async ({ page, scenario }) => {
  const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
  const second = keyEntry("k2", "보조", { ...CONNECTED_KIWOOM, appKeyTail: "5678" });
  const before = keyListOf(first, second);
  scenario.live.kiwoomKeys = before;
  scenario.on(route("DELETE", `${KEYS}/k2`), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first)) }));
  await openKiwoom(page);
  await expect(keyRows(page)).toHaveCount(2);
  const stale = holdNextKeyGet(scenario);
  await stale.received;

  await expandKey(page, "보조");
  await panel(page).getByRole("button", { name: "지우기" }).click();
  await page.getByRole("dialog", { name: /‘보조’ 키를 지웁니다/ }).getByRole("button", { name: "키 지우기" }).click();
  await expect(keyRows(page)).toHaveCount(1);

  const seen = await watchAccounts(page);
  const getsBefore = keyGets(scenario).length;
  stale.release(before);
  await pollSaved(() => keyGets(scenario).length, { timeout: 15_000 }).toBeGreaterThan(getsBefore);
  await expect(keyRows(page)).toHaveCount(1);
  expect((await seen()).maxRows).toBe(1);
});

test("키를 더한 뒤 더하기 전에 나간 목록 폴링 응답이 늦게 와도 더한 줄과 결과가 사라지지 않는다", async ({ page, scenario }) => {
  const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
  const before = keyListOf(first);
  scenario.live.kiwoomKeys = before;
  scenario.on(route("POST", KEYS), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first, keyEntry("k2", "키움 2", { ...CONNECTED_KIWOOM, appKeyTail: "9999" }))) }));
  await openKiwoom(page);
  await expect(keyRows(page)).toHaveCount(1);
  await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
  const form = accounts(page).getByRole("form", { name: "키 더하기" });
  await form.getByLabel("앱키", { exact: true }).fill("FAKEAPPKEYsecond9999");
  await form.getByLabel("시크릿", { exact: true }).fill("FAKESECRETsecond");
  const stale = holdNextKeyGet(scenario);
  await stale.received;
  await form.getByRole("button", { name: "저장하고 연결" }).click();
  await expect(keyRows(page)).toHaveCount(2);
  await expect(accounts(page)).toContainText("토큰 받음");

  const seen = await watchAccounts(page);
  const getsBefore = keyGets(scenario).length;
  stale.release(before);
  await pollSaved(() => keyGets(scenario).length, { timeout: 15_000 }).toBeGreaterThan(getsBefore);
  await expect(keyRows(page)).toHaveCount(2);
  expect(await seen()).toMatchObject({ minRows: 2, resultGone: false });
});

test("줄에서 키를 바꾸면 그 줄의 8050 확인 칸이 비워지고 다시 연결이 꺼진다", async ({ page, scenario }) => {
  const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
  const second = keyEntry("k2", "보조", blocked("5678"));
  scenario.live.kiwoomKeys = keyListOf(first, second);
  scenario.on(route("PUT", `${KEYS}/k2/key`), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first, { ...second, appKeyTail: "9X9X", link: blocked("9X9X") })) }));
  await openKiwoom(page);
  await expandKey(page, "보조");
  await accounts(page).getByLabel(IP_CONFIRMATION).check();
  await accounts(page).getByLabel(LOCK_CONFIRMATION).check();
  await expect(reconnect(page)).toBeEnabled();
  await accounts(page).getByRole("button", { name: "별칭·키 바꾸기" }).click();
  await page.getByLabel("앱키", { exact: true }).fill("NEWKEYabcdefgh9X9X");
  await page.getByLabel("시크릿", { exact: true }).fill("NEWSECRETvalue");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(accounts(page)).toContainText("••••••••••••9X9X");
  await expect(accounts(page).getByLabel(IP_CONFIRMATION)).not.toBeChecked();
  await expect(accounts(page).getByLabel(LOCK_CONFIRMATION)).not.toBeChecked();
  await expect(reconnect(page)).toBeDisabled();
});

test("줄 연결이 연결 중을 거쳐 다시 8050이 되면 확인 칸을 다시 받고 다시 연결이 꺼진다", async ({ page, scenario }) => {
  const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
  const second = keyEntry("k2", "보조", blocked("5678"));
  scenario.live.kiwoomKeys = keyListOf(first, second);
  const connecting: KiwoomLinkStatus = { ...blocked("5678"), state: "connecting", problem: null, step: "token", needsAcknowledgement: false };
  scenario.on(route("POST", `${KEYS}/k2/connect`), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first, { ...second, link: connecting })) }));
  await openKiwoom(page);
  await expandKey(page, "보조");
  await accounts(page).getByLabel(IP_CONFIRMATION).check();
  await accounts(page).getByLabel(LOCK_CONFIRMATION).check();
  await reconnect(page).click();
  await expect(keyRows(page).filter({ hasText: "보조" })).not.toContainText("8050");

  scenario.live.kiwoomKeys = keyListOf(first, { ...second, link: blocked("5678") });
  scenario.live.link({ ...CONNECTED_KIWOOM, message: "시세 키 상태가 바뀌어 목록을 다시 읽게 한다" });
  await expect(keyRows(page).filter({ hasText: "보조" })).toContainText("8050 인증 차단");
  await expect(accounts(page).getByLabel(IP_CONFIRMATION)).not.toBeChecked();
  await expect(accounts(page).getByLabel(LOCK_CONFIRMATION)).not.toBeChecked();
  await expect(reconnect(page)).toBeDisabled();
});

test("방금 더한 키를 지우면 확인 단계가 남지 않고 더하기 단추가 돌아온다", async ({ page, scenario }) => {
  const first = keyEntry("k1", "주계좌", CONNECTED_KIWOOM, { market: true });
  const second = keyEntry("k2", "키움 2", CONNECTED_KIWOOM);
  scenario.live.kiwoomKeys = keyListOf(first);
  scenario.on(route("POST", KEYS), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first, second)) }));
  scenario.on(route("DELETE", `${KEYS}/k2`), () => ({ body: (scenario.live.kiwoomKeys = keyListOf(first)) }));
  await openKiwoom(page);
  await accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" }).click();
  const form = accounts(page).getByRole("form", { name: "키 더하기" });
  await form.getByLabel("앱키", { exact: true }).fill("AAAA1111");
  await form.getByLabel("시크릿", { exact: true }).fill("SECRET1");
  await form.getByRole("button", { name: "저장하고 연결" }).click();
  await expect(accounts(page).getByRole("button", { name: "닫기" })).toBeVisible();
  await expandKey(page, "키움 2");
  await accounts(page).getByRole("button", { name: "지우기" }).click();
  await page.getByRole("dialog", { name: /‘키움 2’ 키를 지웁니다/ }).getByRole("button", { name: "키 지우기" }).click();
  await expect(keyRows(page)).toHaveCount(1);
  await expect(accounts(page).getByRole("button", { name: "＋ 계좌 연결 더하기" })).toBeVisible();
  await expect(accounts(page).getByRole("button", { name: "닫기" })).toHaveCount(0);
});
