import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import type { InitialSyncRequest } from "../src/api/generated/InitialSyncRequest";
import type { KiwoomKeyInput } from "../src/api/generated/KiwoomKeyInput";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import type { RegisteredIpInput } from "../src/api/generated/RegisteredIpInput";
import type { SyncStatus } from "../src/api/generated/SyncStatus";
import { cell, expect, test, type Scenario } from "./harness";
import { CONNECTED_KIWOOM, SYNCED } from "./fixtures/scenario";

const LOGIN_MARKER = "vv.login-started";
const FAKE_KEY: KiwoomKeyInput = { appKey: "FAKEAPPKEYabcdefgh7Z2D", appSecret: "FAKESECRETvalue0123456789xyz" };
const MAX_PRESSES = 5;

const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다", realtimeRegistered: null, symbolCount: null };
const DISCONNECTED: KiwoomLinkStatus = { ...NO_KEY, keySource: "file", appKeyTail: "7Z2D", state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다" };
const NEEDS_CHOICE: SyncStatus = { state: "needs_choice", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null, localDocuments: 4, accountDocuments: 9 };
const signedIn = (sync: SyncStatus = SYNCED): AccountStatus => ({ state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1_762_650_000, sync });
const MISMATCH: AccountStatus = { state: "owner_mismatch", provider: "naver", accountId: "fedcba9876543210fedc", signedInAt: 1_762_650_000, localOwner: "0123456789abcdef0123", sync: SYNCED };

const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);
const wizard = (page: Page) => page.getByRole("dialog", { name: "처음 설정", exact: true });
const steps = (page: Page) => wizard(page).getByRole("list", { name: "설정 단계" });
const current = (page: Page) => steps(page).locator("[aria-current=step]");
const primaries = (page: Page) => page.locator(".btn-primary");
const wizardPrimaries = (page: Page) => wizard(page).locator(".btn-primary");

async function justLoggedIn(page: Page) {
  await page.addInitScript((key) => sessionStorage.setItem(key, "1"), LOGIN_MARKER);
}

async function countPresses(page: Page) {
  await page.addInitScript(() => {
    const counter = window as unknown as { __presses: number };
    counter.__presses = 0;
    document.addEventListener("click", (event) => { if (event.isTrusted) counter.__presses++; }, true);
  });
  return () => page.evaluate(() => (window as unknown as { __presses: number }).__presses);
}

async function recordPrimariesPerFrame(page: Page) {
  await page.addInitScript(() => {
    const record = window as unknown as { __mostPrimaries: number };
    record.__mostPrimaries = 0;
    const sample = () => {
      const dialog = document.querySelector('[role="dialog"][aria-labelledby="setup-wizard-title"]');
      if (dialog) record.__mostPrimaries = Math.max(record.__mostPrimaries, dialog.querySelectorAll(".btn-primary").length);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return () => page.evaluate(() => (window as unknown as { __mostPrimaries: number }).__mostPrimaries);
}

function answerKiwoom(scenario: Scenario) {
  scenario.on(route("PUT", "/api/system/kiwoom/key"), () => {
    scenario.live.link(DISCONNECTED);
    return { body: DISCONNECTED };
  });
  scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "203.0.113.7", checkedAt: Math.floor(scenario.now / 1000) } satisfies PublicIpCheck }));
  scenario.on(route("PUT", "/api/system/kiwoom/registered-ip"), (request) => {
    const input: RegisteredIpInput = request.postDataJSON();
    const next = { ...scenario.live.kiwoomLink, registeredIp: { ip: input.ip, at: Math.floor(scenario.now / 1000) } };
    scenario.live.link(next);
    return { body: next };
  });
}

async function finishPrepare(page: Page) {
  await wizard(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
  await wizard(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
  await wizard(page).getByRole("button", { name: "다음" }).click();
}

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  await dialog.getByRole("tab", { name: "계정", exact: true }).click();
  return dialog;
}

test.describe("처음 설정과 계정 화면", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("로그인된 새 사용자가 키를 넣고 차트를 보기까지 누름이 다섯 이하다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = NO_KEY;
    answerKiwoom(scenario);
    await justLoggedIn(page);
    const presses = await countPresses(page);

    await page.goto("/");
    await expect(current(page)).toContainText("1. 키 준비");
    await finishPrepare(page);
    await expect(current(page)).toContainText("2. 키 붙여넣기");
    await page.getByLabel("앱키", { exact: true }).fill(FAKE_KEY.appKey);
    await page.getByLabel("시크릿", { exact: true }).fill(FAKE_KEY.appSecret);
    await wizard(page).getByRole("button", { name: "저장" }).click();
    expect(callsTo(scenario, "PUT", "/api/system/kiwoom/key").map((r) => r.postDataJSON())).toEqual([FAKE_KEY]);
    scenario.live.link(CONNECTED_KIWOOM);
    await expect(current(page)).toContainText("3. 끝");
    await wizard(page).getByRole("button", { name: "차트 보기" }).click();
    await expect(wizard(page)).toHaveCount(0);
    await expect(cell(page)).toBeVisible();
    expect(await presses()).toBeLessThanOrEqual(MAX_PRESSES);
  });

  test("마법사의 키 준비·키 붙여넣기·끝 화면마다 주요 버튼이 하나뿐이다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = NO_KEY;
    answerKiwoom(scenario);
    await justLoggedIn(page);
    await page.goto("/");
    await expect(current(page)).toContainText("1. 키 준비");
    await expect(wizardPrimaries(page)).toHaveCount(1);
    await expect(wizard(page).getByRole("button", { name: "다음" })).toHaveClass(/btn-primary/);

    await finishPrepare(page);
    await expect(current(page)).toContainText("2. 키 붙여넣기");
    await expect(wizardPrimaries(page)).toHaveCount(1);
    await expect(wizard(page).getByRole("button", { name: "저장" })).toHaveClass(/btn-primary/);

    await wizard(page).getByRole("button", { name: "나중에 하기" }).click();
    await expect(current(page)).toContainText("3. 끝");
    await expect(wizardPrimaries(page)).toHaveCount(1);
    await expect(wizard(page).getByRole("button", { name: "차트 보기" })).toHaveClass(/btn-primary/);
  });

  test("저장한 키를 바꾸는 동안에도 키 붙여넣기 화면의 주요 버튼은 하나뿐이다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = DISCONNECTED;
    answerKiwoom(scenario);
    const mostPrimaries = await recordPrimariesPerFrame(page);
    await justLoggedIn(page);
    await page.goto("/");
    await finishPrepare(page);
    await expect(current(page)).toContainText("2. 키 붙여넣기");
    await expect(wizardPrimaries(page)).toHaveCount(1);
    await expect(wizard(page).getByRole("button", { name: "키움에 연결" })).toHaveClass(/btn-primary/);

    await wizard(page).getByRole("button", { name: "바꾸기" }).click();
    await expect(wizard(page).getByRole("button", { name: "저장" })).toHaveClass(/btn-primary/);
    await expect(wizardPrimaries(page)).toHaveCount(1);

    await wizard(page).getByRole("button", { name: "취소" }).click();
    await expect(wizard(page).getByRole("button", { name: "키움에 연결" })).toHaveClass(/btn-primary/);
    await expect(wizardPrimaries(page)).toHaveCount(1);
    expect(await mostPrimaries()).toBe(1);
  });

  test("셋업 고르기 화면에는 주요 버튼이 둘 이상 없고 덮어쓰기 확인은 위험 단추다", async ({ page, scenario }) => {
    scenario.live.account = signedIn(NEEDS_CHOICE);
    await page.goto("/");
    await expect(current(page)).toContainText("3. 셋업 고르기");
    await expect(wizardPrimaries(page)).toHaveCount(0);
    await wizard(page).getByRole("button", { name: /계정 셋업 받기/ }).click();
    await expect(wizardPrimaries(page)).toHaveCount(0);
    await expect(wizard(page).locator(".btn-danger")).toHaveCount(1);
  });

  test("마법사 카드는 화면 가운데 560px이다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = NO_KEY;
    await justLoggedIn(page);
    await page.goto("/");
    const box = (await steps(page).locator("xpath=..").boundingBox())!;
    expect(Math.round(box.width)).toBe(560);
    expect(Math.round(box.x + box.width / 2)).toBe(720);
  });

  test("Esc로 마법사가 닫힌다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = NO_KEY;
    await justLoggedIn(page);
    await page.goto("/");
    await expect(wizard(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(wizard(page)).toHaveCount(0);
  });

  test("나중에 하기로 건너뛴 단계는 나중에로 남고, Esc로 닫으면 연결 전 안내 카드가 이어 받는다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    scenario.live.kiwoomLink = NO_KEY;
    await justLoggedIn(page);
    await page.goto("/");
    await wizard(page).getByRole("button", { name: "나중에 하기" }).click();
    await expect(current(page)).toContainText("3. 끝");
    await expect(steps(page).getByRole("listitem").filter({ hasText: "1. 키 준비" })).toContainText("나중에");
    await expect(steps(page).getByRole("listitem").filter({ hasText: "2. 키 붙여넣기" })).toContainText("나중에");
    await page.keyboard.press("Escape");
    await expect(wizard(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "키움 연결 안내" }).getByRole("heading", { name: "키움 키를 넣으면 시세가 보입니다" })).toBeVisible();
    expect(callsTo(scenario, "PUT", "/api/system/kiwoom/key")).toHaveLength(0);
  });

  test("계정 셋업으로 덮어쓰는 확인 단추는 위험 단추이고 사라지는 것이 미리 적혀 있다", async ({ page, scenario }) => {
    scenario.live.account = signedIn(NEEDS_CHOICE);
    const sent: InitialSyncRequest[] = [];
    scenario.on(route("POST", "/api/account/initial-sync"), (request) => {
      sent.push(request.postDataJSON());
      return { body: signedIn() };
    });
    await page.goto("/");
    const take = wizard(page).getByRole("button", { name: /계정 셋업 받기/ });
    await expect(take).toContainText("사라지는 것");
    await expect(take).toContainText("이 PC의 문서 4개");
    await expect(wizard(page).getByRole("button", { name: /이 PC 셋업 올리기/ })).toContainText("계정의 문서 9개");
    await take.click();
    const group = wizard(page).getByRole("group", { name: "고른 쪽 확인" });
    const confirm = group.getByRole("button", { name: "계정 셋업으로 덮어쓰기" });
    await expect(confirm).toHaveClass(/btn-danger/);
    await expect(group).toContainText("이 PC에 있는 셋업 문서 4개는 계정 것으로 덮어쓰입니다.");
    expect(Number(await group.locator("p").first().evaluate((node) => getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
    expect(sent).toHaveLength(0);
  });

  test("다른 소유자 화면의 이전 계정으로 다시 로그인이 주요 버튼이고 아무것도 지우지 않는다", async ({ page, scenario }) => {
    scenario.live.account = MISMATCH;
    await page.goto("/");
    const relogin = page.getByRole("button", { name: "이전 계정으로 다시 로그인", exact: true });
    await expect(relogin).toHaveClass(/btn-primary/);
    await expect(primaries(page)).toHaveCount(1);
    await expect(page.getByText("네이버 · 번호", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "이 PC를 지금 계정으로 바꾸기" })).not.toHaveClass(/btn-primary/);
    expect(callsTo(scenario, "POST", "/api/account/replace-local")).toHaveLength(0);
  });

  test("계정 메뉴의 동기화 카드는 오류 상태에서 원인 문장과 지금 동기화 단추를 보인다", async ({ page, scenario }) => {
    scenario.live.account = signedIn({ ...SYNCED, pendingDocuments: 2, lastError: "unreachable" });
    let synced = 0;
    scenario.on(route("POST", "/api/account/sync"), () => {
      synced++;
      const next = signedIn();
      scenario.live.setAccount(next);
      return { body: next };
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const dialog = await openAccountMenu(page);
    const card = dialog.getByRole("region", { name: "동기화" });
    await expect(card.getByRole("alert")).toContainText("계정 서버에 닿지 못해 변경 2개를 올리지 못했습니다");
    await expect(card.getByRole("button", { name: "지금 동기화" })).toBeVisible();
    await card.getByRole("button", { name: "지금 동기화" }).click();
    await expect(card.getByText("동기화됨", { exact: true })).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(synced).toBe(1);
  });
});
