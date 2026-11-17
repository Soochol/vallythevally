import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import type { InitialSyncRequest } from "../src/api/generated/InitialSyncRequest";
import type { KiwoomKeyInput } from "../src/api/generated/KiwoomKeyInput";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import type { RegisteredIpInput } from "../src/api/generated/RegisteredIpInput";
import type { SyncStatus } from "../src/api/generated/SyncStatus";
import { cell, chartOf, expect, test, type Scenario } from "./harness";
import { CONNECTED_KIWOOM, SYNCED } from "./fixtures/scenario";

const SCREENS = path.resolve("../target/ux-screens");
const LOGIN_MARKER = "vv.login-started";
const FAKE_KEY: KiwoomKeyInput = { appKey: "FAKEAPPKEYabcdefgh7Z2D", appSecret: "FAKESECRETvalue0123456789xyz" };
const SETUP_PATHS = ["/api/layouts", "/api/watchlists", "/api/ui-state"];

const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다", realtimeRegistered: null, symbolCount: null };
const DISCONNECTED: KiwoomLinkStatus = { ...NO_KEY, keySource: "file", appKeyTail: "7Z2D", state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다" };
const signedIn = (sync: SyncStatus = SYNCED): AccountStatus => ({ state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1_762_650_000, sync });
const NEEDS_CHOICE: SyncStatus = { state: "needs_choice", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null, localDocuments: 4, accountDocuments: 9 };

const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);
const setupCalls = (scenario: Scenario) => scenario.requests.filter((r) => r.method() === "GET" && SETUP_PATHS.includes(new URL(r.url()).pathname));
const wizard = (page: Page) => page.getByRole("dialog", { name: "처음 설정", exact: true });
const steps = (page: Page) => wizard(page).getByRole("list", { name: "설정 단계" });
const current = (page: Page) => steps(page).locator("[aria-current=step]");

async function shot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, name) });
}

async function justLoggedIn(page: Page) {
  await page.addInitScript((key) => sessionStorage.setItem(key, "1"), LOGIN_MARKER);
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
  scenario.on(route("POST", "/api/system/kiwoom/connect"), () => {
    scenario.live.link(CONNECTED_KIWOOM);
    return { body: CONNECTED_KIWOOM };
  });
}

for (const viewport of [{ name: "1440×900", width: 1440, height: 900, tag: "desktop" }, { name: "390×844", width: 390, height: 844, tag: "phone" }]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("로그인 직후 돌아오면 ①완료 ②IP 확인부터 열리고, IP 확인 → 키 저장 → 연결 진행이 이어진다. 키 저장 뒤 화면은 연결 요청을 따로 보내지 않는다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = NO_KEY;
      answerKiwoom(scenario);
      await justLoggedIn(page);

      await page.goto("/");
      await expect(wizard(page)).toBeVisible();
      await expect(current(page)).toContainText("2. IP 확인");
      await expect(steps(page).getByRole("listitem").filter({ hasText: "1. 로그인" })).toContainText("끝");
      await expect(wizard(page)).toContainText("Google 계정으로 로그인했습니다");
      await expect(wizard(page).getByRole("button", { name: "이전" })).toHaveCount(0);
      await expect(wizard(page).getByRole("button", { name: "다음" })).toBeDisabled();
      await wizard(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
      await expect(wizard(page)).toContainText("203.0.113.7");
      await wizard(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
      await expect(wizard(page).getByLabel("반복 발급 잠금이 풀렸는지 확인했습니다")).toHaveCount(0);
      await expect(wizard(page).getByRole("button", { name: "다음" })).toBeEnabled();
      expect(callsTo(scenario, "PUT", "/api/system/kiwoom/registered-ip").map((r) => r.postDataJSON())).toEqual([{ ip: "203.0.113.7" }]);
      await shot(page, `setup-wizard-${viewport.tag}-1-ip.png`);
      await wizard(page).getByRole("button", { name: "다음" }).click();

      await expect(current(page)).toContainText("3. 키움 키");
      await expect(wizard(page).getByRole("button", { name: "다음" })).toBeDisabled();
      await expect(wizard(page)).toContainText("저장하면 바로 키움에 연결합니다. 포털에 지금 공인 IP를 먼저 등록하세요");
      await shot(page, `setup-wizard-${viewport.tag}-2-key.png`);
      await page.getByLabel("앱키", { exact: true }).fill(FAKE_KEY.appKey);
      await page.getByLabel("시크릿", { exact: true }).fill(FAKE_KEY.appSecret);
      await wizard(page).getByRole("button", { name: "저장" }).click();
      await expect(wizard(page).getByRole("button", { name: "바꾸기" })).toBeVisible();
      expect(callsTo(scenario, "PUT", "/api/system/kiwoom/key").map((r) => r.postDataJSON())).toEqual([FAKE_KEY]);
      await wizard(page).getByRole("button", { name: "다음" }).click();

      await expect(current(page)).toContainText("4. 연결");
      scenario.live.link({ ...CONNECTED_KIWOOM, state: "connecting", step: "token", realtimeRegistered: null, symbolCount: null });
      await expect(wizard(page).getByRole("heading", { name: "연결 중" })).toBeVisible();
      await expect(wizard(page).getByRole("list", { name: "연결 단계" })).toBeVisible();
      await shot(page, `setup-wizard-${viewport.tag}-3-connect.png`);
      scenario.live.link(CONNECTED_KIWOOM);
      await expect(wizard(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
      await expect(wizard(page)).toContainText("다음부터는 서버를 켜면 자동으로 연결합니다");
      expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect")).toHaveLength(0);
      await wizard(page).getByRole("button", { name: "다음" }).click();

      await expect(current(page)).toContainText("5. 기본 셋업");
      await expect(wizard(page)).toContainText("이 PC의 셋업이 계정과 이미 맞습니다.");
      await shot(page, `setup-wizard-${viewport.tag}-4-setup.png`);
      await wizard(page).getByRole("button", { name: "닫기" }).click();
      await expect(wizard(page)).toHaveCount(0);
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    });

    test("연결 단계에서 연결 안 함이면 연결 단추를, 네트워크 실패면 다시 시도 단추를 보인다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = { ...DISCONNECTED, atStart: "keptDisconnected" };
      answerKiwoom(scenario);
      await justLoggedIn(page);
      await page.goto("/");
      await wizard(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
      await wizard(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
      await wizard(page).getByRole("button", { name: "다음" }).click();
      await wizard(page).getByRole("button", { name: "다음" }).click();
      await expect(current(page)).toContainText("4. 연결");
      await expect(wizard(page)).toContainText("연결하면 다음부터 서버를 켤 때 자동으로 연결합니다");
      await wizard(page).getByRole("button", { name: "키움에 연결" }).click();
      await expect(wizard(page).getByRole("heading", { name: "연결됨" })).toBeVisible();
      expect(callsTo(scenario, "POST", "/api/system/kiwoom/connect").map((r) => r.postDataJSON())).toEqual([{ acknowledged: false }]);
    });

    test("나중에 하기로 ②~④를 건너뛰면 연결 전 안내 카드가 이어 받는다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = NO_KEY;
      await justLoggedIn(page);
      await page.goto("/");
      await wizard(page).getByRole("button", { name: "나중에 하기" }).click();
      await expect(current(page)).toContainText("5. 기본 셋업");
      await expect(steps(page).getByRole("listitem").filter({ hasText: "3. 키움 키" })).toContainText("나중에");
      await wizard(page).getByRole("button", { name: "닫기" }).click();
      await expect(page.getByRole("region", { name: "키움 연결 안내" }).getByRole("heading", { name: "키움 키를 넣으면 시세가 보입니다" })).toBeVisible();
      expect(callsTo(scenario, "PUT", "/api/system/kiwoom/key")).toHaveLength(0);
    });

    test(".env 키여도 IP 확인부터 열리고, 다음 단계의 키는 읽기 전용이다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = { ...DISCONNECTED, keySource: "env" };
      await justLoggedIn(page);
      await page.goto("/");
      await expect(current(page)).toContainText("2. IP 확인");
      await wizard(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
      await wizard(page).getByRole("button", { name: "다음" }).click();
      await expect(wizard(page)).toContainText(".env에서 읽음");
      await expect(wizard(page).locator("input[type=password], input[type=text]")).toHaveCount(0);
      await expect(wizard(page)).not.toContainText("저장하면 바로 키움에 연결합니다");
    });

    test("needs_choice: 두 선택과 문서 수가 보이고, 확인 뒤에만 initial-sync가 가며, 그 전에는 셋업을 읽지 않는다", async ({ page, scenario }) => {
      scenario.live.account = signedIn(NEEDS_CHOICE);
      const sent: InitialSyncRequest[] = [];
      scenario.on(route("POST", "/api/account/initial-sync"), (request) => {
        sent.push(request.postDataJSON());
        const next = signedIn();
        scenario.live.setAccount(next);
        return { body: next };
      });

      await page.goto("/");
      await expect(wizard(page)).toBeVisible();
      await expect(current(page)).toContainText("5. 기본 셋업");
      await expect(wizard(page).getByRole("button", { name: /이 PC 셋업 올리기/ })).toContainText("이 PC의 문서 4개를 계정에 올립니다.");
      await expect(wizard(page).getByRole("button", { name: /계정 셋업 받기/ })).toContainText("계정의 문서 9개를 이 PC로 받습니다.");
      await expect(wizard(page).getByRole("button", { name: "닫기" })).toHaveCount(0);
      await shot(page, `setup-wizard-${viewport.tag}-5-choose.png`);

      await wizard(page).getByRole("button", { name: /계정 셋업 받기/ }).click();
      await expect(wizard(page).getByRole("group", { name: "고른 쪽 확인" })).toContainText("이 PC에 있는 셋업 문서 4개는 계정 것으로 덮어쓰입니다.");
      expect(sent).toHaveLength(0);
      expect(setupCalls(scenario)).toHaveLength(0);
      await shot(page, `setup-wizard-${viewport.tag}-6-choose-confirm.png`);

      await wizard(page).getByRole("button", { name: "계정 셋업으로 덮어쓰기" }).click();
      await expect(wizard(page)).toContainText("계정의 셋업을 이 PC로 받았습니다.");
      expect(sent).toEqual([{ choice: "take_account" }]);
      await expect.poll(() => setupCalls(scenario).length).toBeGreaterThan(0);
      await wizard(page).getByRole("button", { name: "닫기" }).click();
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    });

    test("needs_choice에서 이 PC 셋업 올리기를 고르면 upload_local이 간다", async ({ page, scenario }) => {
      scenario.live.account = signedIn(NEEDS_CHOICE);
      const sent: InitialSyncRequest[] = [];
      scenario.on(route("POST", "/api/account/initial-sync"), (request) => {
        sent.push(request.postDataJSON());
        scenario.live.setAccount(signedIn());
        return { body: signedIn() };
      });
      await page.goto("/");
      await wizard(page).getByRole("button", { name: /이 PC 셋업 올리기/ }).click();
      await expect(wizard(page).getByRole("group", { name: "고른 쪽 확인" })).toContainText("계정에 있는 셋업 문서 9개는 이 PC 것으로 덮어쓰입니다.");
      await wizard(page).getByRole("button", { name: "이 PC 셋업으로 덮어쓰기" }).click();
      await expect(wizard(page)).toContainText("이 PC의 셋업을 계정에 올렸습니다.");
      expect(sent).toEqual([{ choice: "upload_local" }]);
    });

    test("밀어 준 setup_changed에 알림이 보이고, 새로 고침을 누르기 전에는 쪽이 다시 읽히지 않는다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      await page.goto("/");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      const before = setupCalls(scenario).length;
      expect(before).toBeGreaterThan(0);

      scenario.live.emit({ type: "setup_changed", kinds: ["layout", "watchlists"] });
      const notice = page.getByRole("status").filter({ hasText: "다른 PC에서 바뀐 셋업이 있습니다" });
      await expect(notice).toBeVisible();
      await shot(page, `setup-changed-${viewport.tag}.png`);
      expect(setupCalls(scenario)).toHaveLength(before);

      await notice.getByRole("button", { name: "새로 고침" }).click();
      await expect.poll(() => setupCalls(scenario).length).toBeGreaterThan(before);
    });

    test("마법사는 계정 메뉴에서 다시 열 수 있고, 계정 메뉴가 동기화 값을 보이며 지금 동기화가 요청을 보낸다", async ({ page, scenario }) => {
      scenario.live.account = signedIn({ ...SYNCED, pendingDocuments: 2, refusedDocuments: 1, lastError: "unreachable" });
      let synced = 0;
      scenario.on(route("POST", "/api/account/sync"), () => {
        synced++;
        const next = signedIn();
        scenario.live.setAccount(next);
        return { body: next };
      });
      await page.goto("/");
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
      await dialog.getByRole("tab", { name: "계정", exact: true }).click();
      const sync = dialog.getByRole("region", { name: "동기화" });
      await expect(sync).toContainText("올리지 못한 변경2개");
      await expect(sync).toContainText("거절된 문서1개");
      await expect(sync).toContainText("계정 서버에 닿지 못했습니다");
      await shot(page, `account-sync-${viewport.tag}.png`);
      await sync.getByRole("button", { name: "지금 동기화" }).click();
      await expect(sync).toContainText("마지막 오류없음");
      expect(synced).toBe(1);

      await dialog.getByRole("button", { name: "셋업 마법사 다시 열기" }).click();
      await expect(wizard(page)).toBeVisible();
      await expect(current(page)).toContainText("5. 기본 셋업");
      await wizard(page).getByRole("button", { name: "닫기" }).click();
      await expect(wizard(page)).toHaveCount(0);
    });

    test("마법사가 열려 있는 동안 차트 단축키는 일하지 않는다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = NO_KEY;
      await justLoggedIn(page);
      await page.goto("/");
      await wizard(page).getByRole("heading", { name: "처음 설정" }).click();
      await page.keyboard.press("/");
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(wizard(page)).toBeVisible();
    });

    test("마법사 단계와 단추가 화면 안에 들어온다", async ({ page, scenario }) => {
      scenario.live.account = signedIn();
      scenario.live.kiwoomLink = NO_KEY;
      await justLoggedIn(page);
      await page.goto("/");
      await expect(current(page)).toContainText("2. IP 확인");
      const box = await steps(page).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const name of ["나중에 하기", "다음"]) {
        const button = await wizard(page).getByRole("button", { name }).boundingBox();
        expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
      }
    });
  });
}

test.describe("동기화 표시와 로컬 전용", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const indicator = (page: Page) => page.getByRole("status", { name: /^계정 동기화:/ });

  test("동기화 상태 값별로 상태 줄 문장이 바뀐다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const table: [SyncStatus, string][] = [
      [SYNCED, "동기화됨"],
      [{ ...SYNCED, pendingDocuments: 2 }, "올리는 중"],
      [{ ...SYNCED, pendingDocuments: 3, lastError: "unreachable" }, "올리지 못한 변경 3개 · 계정 서버에 닿지 못함"],
      [{ ...SYNCED, refusedDocuments: 2, lastError: "rejected" }, "거절된 문서 2개"],
    ];
    for (const [sync, text] of table) {
      scenario.live.setAccount(signedIn(sync));
      await expect(indicator(page)).toHaveText(text);
      await shot(page, `sync-indicator-${text.slice(0, 4).replace(/\s/g, "")}.png`);
    }
    await indicator(page).click();
    await expect(page.getByRole("dialog", { name: "시스템 설정", exact: true }).getByRole("tab", { name: "계정", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test("로컬 전용: 동기화 표시도 마법사도 없다. 로그인 표시가 남아 있어도 열리지 않는다", async ({ page, scenario }) => {
    scenario.live.account = { state: "local_only" };
    await justLoggedIn(page);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(indicator(page)).toHaveCount(0);
    await expect(wizard(page)).toHaveCount(0);
  });
});

test.describe("셋업 알림과 선택 대기의 경계", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const notice = (page: Page) => page.getByRole("status").filter({ hasText: "다른 PC에서 바뀐 셋업이 있습니다" });
  const uiStateReads = (scenario: Scenario) => scenario.requests.filter((r) => r.method() === "GET" && new URL(r.url()).pathname === "/api/ui-state").length;

  test("복원하는 도중에 온 setup_changed도 복원이 끝나면 알림으로 보인다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received = () => {};
    const arrived = new Promise<void>((resolve) => { received = resolve; });
    let first = true;
    scenario.on((url, request) => first && url.pathname.startsWith("/api/layouts") && request.method() === "GET", async (request) => {
      first = false;
      received();
      await gate;
      return scenario.respond(request);
    });
    await page.goto("/?symbol=005930");
    await arrived;
    scenario.live.emit({ type: "setup_changed", kinds: ["watchlists"] });
    release();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(notice(page)).toBeVisible();
  });

  test("저장이 끝나지 않아도 알림은 나중에로 닫을 수 있고, 저장이 끝나기 전에는 새로 고치지 않는다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const held = scenario.hold((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT");
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
    await held.received;
    scenario.live.emit({ type: "setup_changed", kinds: ["layout"] });
    const before = uiStateReads(scenario);
    await notice(page).getByRole("button", { name: "새로 고침" }).click();
    await expect(notice(page).getByRole("button", { name: "나중에" })).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(uiStateReads(scenario)).toBe(before);
    await notice(page).getByRole("button", { name: "나중에" }).click();
    await expect(notice(page)).toHaveCount(0);
  });

  test("드로잉 저장이 끝나지 않았으면 새로 고치지 않는다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    const loaded = page.waitForResponse((response) => response.url().includes("/api/drawings?") && response.request().method() === "GET");
    await page.goto("/");
    await (await loaded).finished();
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
    await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
    const held = scenario.hold((url, request) => url.pathname.startsWith("/api/drawings/") && request.method() === "PUT");
    const bounds = await chartOf(cell(page)).boundingBox();
    await cell(page).focus();
    await page.keyboard.press("H");
    await page.mouse.click(bounds!.x + bounds!.width * 0.75, bounds!.y + bounds!.height * 0.4);
    await held.received;
    scenario.live.emit({ type: "setup_changed", kinds: ["drawing"] });
    const before = uiStateReads(scenario);
    await notice(page).getByRole("button", { name: "새로 고침" }).click();
    await page.waitForTimeout(1500);
    expect(uiStateReads(scenario)).toBe(before);
  });

  test("실행 중이던 탭에 needs_choice가 오면 고르기 전에 셋업을 읽지 않는다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    scenario.live.setAccount({ state: "signed_out" });
    await expect(page.getByTestId("landing")).toBeVisible();
    const before = scenario.requests.length;
    scenario.live.setAccount(signedIn(NEEDS_CHOICE));
    await expect(wizard(page)).toBeVisible();
    await page.waitForTimeout(1000);
    const reads = scenario.requests.slice(before).filter((r) => r.method() === "GET" && /^\/api\/(layouts|watchlists|ui-state|screens|drawings)/.test(new URL(r.url()).pathname));
    expect(reads).toHaveLength(0);
    await expect(cell(page)).toHaveCount(0);
  });

  test("새로 고침 뒤 나중에를 누르면 저장이 끝나도 쪽을 새로 고치지 않고, 다음 알림의 새로 고침은 눌린다", async ({ page, scenario }) => {
    scenario.live.account = signedIn();
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received = () => {};
    const arrived = new Promise<void>((resolve) => { received = resolve; });
    let first = true;
    scenario.on((url, request) => first && url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", async (request) => {
      first = false;
      received();
      await gate;
      return scenario.respond(request);
    });
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "주", exact: true }).click();
    await arrived;
    scenario.live.emit({ type: "setup_changed", kinds: ["layout"] });
    await notice(page).getByRole("button", { name: "새로 고침" }).click();
    await notice(page).getByRole("button", { name: "나중에" }).click();
    await expect(notice(page)).toHaveCount(0);
    let loads = 0;
    page.on("load", () => { loads++; });
    release();
    await page.waitForTimeout(1500);
    expect(loads).toBe(0);
    scenario.live.emit({ type: "setup_changed", kinds: ["watchlists"] });
    await expect(notice(page).getByRole("button", { name: "새로 고침" })).toBeEnabled();
  });

  test("계정 셋업 받기 응답 뒤에 늦게 온 setup_changed로는 알림이 뜨지 않는다", async ({ page, scenario }) => {
    scenario.live.account = signedIn(NEEDS_CHOICE);
    scenario.on(route("POST", "/api/account/initial-sync"), () => {
      const next = signedIn();
      scenario.live.setAccount(next);
      setTimeout(() => scenario.live.emit({ type: "setup_changed", kinds: ["layout", "watchlists"] }), 300);
      return { body: next };
    });
    await page.goto("/");
    await wizard(page).getByRole("button", { name: /계정 셋업 받기/ }).click();
    await wizard(page).getByRole("button", { name: "계정 셋업으로 덮어쓰기" }).click();
    await wizard(page).getByRole("button", { name: "닫기" }).click();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.waitForTimeout(1000);
    await expect(notice(page)).toHaveCount(0);
  });
});
