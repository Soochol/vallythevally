import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import { cell, expect, test, type Scenario } from "./harness";

const SCREENS = path.resolve("../target/ux-screens");
const ACCOUNT_ID = "0123456789abcdef0123";
const SIGNED_OUT: AccountStatus = { state: "signed_out" };
const SIGNED_IN: AccountStatus = { state: "signed_in", provider: "google", accountId: ACCOUNT_ID, signedInAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 };
const MISMATCH: AccountStatus = { state: "owner_mismatch", provider: "naver", accountId: "fedcba9876543210fedc", signedInAt: SIGNED_IN.state === "signed_in" ? SIGNED_IN.signedInAt : 0, localOwner: ACCOUNT_ID };
const SETUP_PATHS = ["/api/layouts", "/api/watchlists", "/api/ui-state"];

const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);
const setupCalls = (scenario: Scenario) => scenario.requests.filter((r) => SETUP_PATHS.includes(new URL(r.url()).pathname));
const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });

async function shot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, name) });
}

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: "계정", exact: true }).click();
}

function answerStatus(scenario: Scenario, pathname: string, next: AccountStatus) {
  scenario.on(route("POST", pathname), () => {
    scenario.live.setAccount(next);
    return { body: next };
  });
}

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("signed_out: 로그인 화면만 보이고 셋업을 읽지 않는다. Google 단추는 돌려준 주소로 이동한다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    let started: unknown = null;
    await page.route("**/fake-idp/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>idp</title>" }));
    scenario.on(route("POST", "/api/account/login"), (request) => {
      started = request.postDataJSON();
      return { body: { url: `${new URL(request.url()).origin}/fake-idp/start?state=abc` } };
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Google로 로그인" })).toBeVisible();
    await expect(page.getByRole("button", { name: "네이버로 로그인" })).toBeVisible();
    await expect(page.locator("input")).toHaveCount(0);
    await expect(page.getByText("로그인한 계정의 고유 번호만 받습니다. 이메일과 이름은 받지 않습니다.")).toBeVisible();
    await expect(page.getByText(/Google과 네이버는 서로 다른 계정/)).toBeVisible();
    await expect(page.getByRole("button", { name: "시스템 설정", exact: true })).toHaveCount(0);
    await shot(page, "account-login-desktop.png");

    await page.getByRole("button", { name: "Google로 로그인" }).click();
    await expect(page).toHaveURL(/\/fake-idp\/start\?state=abc$/);
    expect(started).toEqual({ provider: "google" });
    expect(setupCalls(scenario)).toHaveLength(0);
  });

  test("로그인 시작이 실패하면 이유를 보이고 다시 누를 수 있다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    scenario.reply(route("POST", "/api/account/login"), { status: 503, body: { error: { code: "account_server_unavailable", message: "계정 서버에 연결하지 못했습니다" } } });
    await page.goto("/");
    await page.getByRole("button", { name: "네이버로 로그인" }).click();
    await expect(page.getByRole("alert")).toHaveText("계정 서버에 연결하지 못했습니다");
    await expect(page.getByRole("button", { name: "네이버로 로그인" })).toBeEnabled();
  });

  for (const reason of ["access_denied", "cancelled"]) {
    test(`/?login=error&reason=${reason}: 취소 문장을 보이고 주소창의 쿼리를 지운다`, async ({ page, scenario }) => {
      scenario.live.account = SIGNED_OUT;
      await page.goto(`/?login=error&reason=${reason}`);
      await expect(page.getByText("로그인을 취소했습니다")).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).search).toBe("");
    });
  }

  test("로그인 실패 이유는 이유별 문장으로 보인다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.goto("/?login=error&reason=server_unreachable");
    await expect(page.getByText("계정 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요")).toBeVisible();
  });

  test("signed_in: 지금 화면이 열리고 계정 메뉴에 provider와 짧은 id가 보인다. 로그아웃하면 로그인 화면으로 바뀐다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    answerStatus(scenario, "/api/account/logout", SIGNED_OUT);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toHaveCount(0);

    await openAccountMenu(page);
    const panel = dialog(page).getByRole("tabpanel");
    await expect(panel.getByText("Google", { exact: true })).toBeVisible();
    await expect(panel.getByText(ACCOUNT_ID.slice(0, 8), { exact: true })).toBeVisible();
    await expect(panel.getByText(ACCOUNT_ID)).toHaveCount(0);
    await expect(panel.getByText("2026. 11. 9.")).toBeVisible();
    await shot(page, "account-menu-desktop.png");

    await panel.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    expect(callsTo(scenario, "POST", "/api/account/logout")).toHaveLength(1);
  });

  test("실행 중에 서버가 signed_out을 밀어 주면 로그인 화면으로 바뀌고 차트 칸이 사라진다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    scenario.live.setAccount(SIGNED_OUT);
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    await expect(cell(page)).toHaveCount(0);
  });

  test("복원하는 도중 signed_out이 오면 복원이 끝나도 저장을 시작하지 않는다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    const held = scenario.hold(route("GET", "/api/ui-state"));
    await page.goto("/?symbol=005930");
    await held.received;
    scenario.live.setAccount(SIGNED_OUT);
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    held.reply({ body: scenario.documents.uiState() });
    await page.waitForTimeout(1500);
    expect(scenario.requests.filter((r) => r.method() === "PUT")).toHaveLength(0);
    await expect(cell(page)).toHaveCount(0);
  });

  test("로그인 화면이 아닌 상태로 돌아와도 실패 문장을 알림으로 보이고 주소창을 정리한다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    await page.goto("/?symbol=005930&login=error&reason=storage");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("이 PC에 로그인 정보를 저장하지 못했습니다", { exact: false })).toBeVisible();
    await expect.poll(() => ["login", "reason"].some((key) => new URL(page.url()).searchParams.has(key))).toBe(false);
  });

  test("한 번 본 실패 문장은 다음 로그인 화면에 다시 나오지 않는다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    await page.goto("/?symbol=005930&login=error&reason=state");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    scenario.live.setAccount(SIGNED_OUT);
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
    await expect(page.getByText("이 브라우저에서 시작한 로그인이 아니어서", { exact: false })).toHaveCount(0);
  });

  test("owner_mismatch: 확인 화면이 보이고 지우고 바꾸기는 두 단계 확인 뒤에만 요청이 간다", async ({ page, scenario }) => {
    scenario.live.account = MISMATCH;
    answerStatus(scenario, "/api/account/replace-local", SIGNED_IN);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "이 PC의 셋업은 다른 계정 것입니다" })).toBeVisible();
    await expect(page.getByText(ACCOUNT_ID.slice(0, 8), { exact: true })).toBeVisible();
    await expect(page.getByText(/fedcba98/)).toBeVisible();
    expect(setupCalls(scenario)).toHaveLength(0);
    await shot(page, "account-mismatch-desktop.png");

    await page.getByRole("button", { name: "이 PC 셋업 지우고 바꾸기" }).click();
    expect(callsTo(scenario, "POST", "/api/account/replace-local")).toHaveLength(0);
    await expect(page.getByRole("button", { name: "취소" })).toBeFocused();
    await shot(page, "account-mismatch-confirm-desktop.png");
    await page.getByRole("button", { name: "취소" }).click();
    await expect(page.getByRole("button", { name: "이 PC 셋업 지우고 바꾸기" })).toBeFocused();
    expect(callsTo(scenario, "POST", "/api/account/replace-local")).toHaveLength(0);

    await page.getByRole("button", { name: "이 PC 셋업 지우고 바꾸기" }).click();
    await page.getByRole("button", { name: "지우고 바꾸기", exact: true }).click();
    await expect(cell(page)).toBeVisible();
    const calls = callsTo(scenario, "POST", "/api/account/replace-local");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.postDataJSON()).toEqual({ confirm: true });
    expect(setupCalls(scenario).length).toBeGreaterThan(0);
  });

  test("바꾸기가 끝나면 이전 계정의 미저장 편집은 새 계정으로 올라가지 않는다", async ({ page, scenario }) => {
    scenario.live.account = MISMATCH;
    answerStatus(scenario, "/api/account/replace-local", SIGNED_IN);
    await page.addInitScript(() => localStorage.setItem("vv.unsaved.watchlist", JSON.stringify({ path: "/api/watchlists", revision: 9_999_999_999_999, body: JSON.stringify({ lists: [{ id: "old", name: "이전계정목록", symbols: [] }], revision: 9_999_999_999_999 }) })));
    await page.goto("/");
    await page.getByRole("button", { name: "이 PC 셋업 지우고 바꾸기" }).click();
    await page.getByRole("button", { name: "지우고 바꾸기", exact: true }).click();
    await expect(cell(page)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(scenario.requests.filter((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/watchlists")).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.getItem("vv.unsaved.watchlist"))).toBeNull();
  });

  test("owner_mismatch에서 로그아웃하면 로그인 화면이 된다", async ({ page, scenario }) => {
    scenario.live.account = MISMATCH;
    answerStatus(scenario, "/api/account/logout", SIGNED_OUT);
    await page.goto("/");
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
  });

  test("계정 삭제: 확인 문구를 넣기 전에는 단추가 꺼져 있고, 서버가 실패하면 아무것도 지워지지 않았다고 보인다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    scenario.reply(route("POST", "/api/account/delete"), { status: 503, body: { error: { code: "account_server_unavailable", message: "계정 서버에 연결하지 못했습니다" } } });
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await openAccountMenu(page);
    const panel = dialog(page).getByRole("tabpanel");
    await panel.getByRole("button", { name: "계정 삭제", exact: true }).click();
    await expect(panel.getByRole("textbox")).toBeFocused();
    await expect(panel.getByText("이 PC의 셋업은 남습니다", { exact: false })).toBeVisible();
    const run = panel.getByRole("button", { name: "계정 삭제 실행" });
    await expect(run).toBeDisabled();
    await panel.getByRole("textbox").fill("계정");
    await expect(run).toBeDisabled();
    await panel.getByRole("textbox").fill("계정 삭제");
    await expect(run).toBeEnabled();
    await run.click();
    await expect(panel.getByRole("alert")).toContainText("아무것도 지워지지 않았습니다");
    expect(callsTo(scenario, "POST", "/api/account/delete")).toHaveLength(1);
    expect(callsTo(scenario, "POST", "/api/account/delete")[0]!.postDataJSON()).toEqual({ confirm: true });
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toHaveCount(0);
  });

  test("계정 삭제가 끝나면 로그인 화면이 된다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_IN;
    answerStatus(scenario, "/api/account/delete", SIGNED_OUT);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await openAccountMenu(page);
    const panel = dialog(page).getByRole("tabpanel");
    await panel.getByRole("button", { name: "계정 삭제", exact: true }).click();
    await panel.getByRole("textbox").fill("계정 삭제");
    await panel.getByRole("button", { name: "계정 삭제 실행" }).click();
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toBeVisible();
  });

  test("local_only: 로그인 화면이 없고 계정 메뉴가 로컬 전용 문장을 보인다", async ({ page }) => {
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("heading", { name: "로그인", exact: true })).toHaveCount(0);
    await openAccountMenu(page);
    await expect(dialog(page).getByRole("tabpanel").getByText("계정 서버를 쓰지 않습니다. 셋업은 이 PC에만 있습니다.")).toBeVisible();
  });
});

test.describe("휴대폰 폭", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("로그인 화면 단추가 화면 안에 들어온다", async ({ page, scenario }) => {
    scenario.live.account = SIGNED_OUT;
    await page.goto("/");
    for (const name of ["Google로 로그인", "네이버로 로그인"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, "account-login-phone.png");
  });

  test("계정 바꾸기 확인 화면과 계정 메뉴도 화면 안에 들어온다", async ({ page, scenario }) => {
    scenario.live.account = MISMATCH;
    await page.goto("/");
    await page.getByRole("button", { name: "이 PC 셋업 지우고 바꾸기" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, "account-mismatch-phone.png");
    scenario.live.setAccount(SIGNED_IN);
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await dialog(page).getByRole("tab", { name: "계정", exact: true }).click();
    await expect(dialog(page).getByText(ACCOUNT_ID.slice(0, 8), { exact: true })).toBeVisible();
    await shot(page, "account-menu-phone.png");
  });
});
