import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../src/api/generated/PublicIpCheck";
import type { RegisteredIpInput } from "../src/api/generated/RegisteredIpInput";
import { CONNECTED_KIWOOM, SYNCED } from "./fixtures/scenario";
import { cell, expect, type Scenario, test } from "./harness";

const TRIMMED = "앞뒤 공백을 지웠습니다";
const PASTED_KEY = "FAKEAPPKEYabcdefgh7Z2D";
const LOGIN_MARKER = "vv.login-started";

const NO_KEY: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, keySource: "none", appKeyTail: null, state: "noKey", message: "키움 키가 없습니다. 저장만 하고 키움에는 아무것도 보내지 않습니다", realtimeRegistered: null, symbolCount: null };
const DISCONNECTED: KiwoomLinkStatus = { ...NO_KEY, keySource: "file", appKeyTail: "7Z2D", state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다" };
const signedIn = (): AccountStatus => ({ state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1_762_650_000, sync: SYNCED });

const route = (method: string, pathname: string) => (url: URL, request: { method(): string }) => url.pathname === pathname && request.method() === method;
const settings = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const wizard = (page: Page) => page.getByRole("dialog", { name: "처음 설정", exact: true });
const secret = (page: Page, label: "앱키" | "시크릿") => settings(page).getByLabel(label, { exact: true });
const pasteButton = (page: Page, label: "앱키" | "시크릿") => settings(page).locator(".ui-field-cell", { has: page.getByLabel(label, { exact: true }) }).getByRole("button", { name: "붙여넣기", exact: true });

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("앞뒤 공백 알림은 실제로 자른 때만 뜬다", () => {
  test.beforeEach(async ({ page, scenario }) => {
    scenario.live.kiwoomLink = NO_KEY;
    await page.addInitScript((text) => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text, writeText: async () => undefined } });
    }, `  ${PASTED_KEY}  `);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await settings(page).getByRole("tabpanel").getByRole("region", { name: "계좌 목록" }).getByRole("group", { name: "증권사 고르기" }).getByRole("button", { name: /^키움증권/ }).click();
    await expect(secret(page, "앱키")).toBeVisible();
  });

  test("붙여넣기 버튼으로 넣은 앱키의 앞뒤 공백을 자르면 알림이 뜬다", async ({ page }) => {
    await pasteButton(page, "앱키").click();
    await expect(secret(page, "앱키")).toHaveValue(PASTED_KEY);
    await expect(secret(page, "앱키")).toHaveAccessibleDescription(new RegExp(TRIMMED));
  });

  test("직접 친 끝 공백을 Backspace로 지우면 알림이 뜨지 않는다", async ({ page }) => {
    await secret(page, "시크릿").pressSequentially("ABC ");
    await secret(page, "시크릿").press("Backspace");
    await expect(secret(page, "시크릿")).toHaveValue("ABC");
    await expect(secret(page, "시크릿")).not.toHaveAccessibleDescription(new RegExp(TRIMMED));
    await expect(settings(page)).not.toContainText(TRIMMED);
  });
});

function answerIp(scenario: Scenario) {
  scenario.on(route("POST", "/api/system/kiwoom/ip-check"), () => ({ body: { ip: "203.0.113.7", checkedAt: Math.floor(scenario.now / 1000) } satisfies PublicIpCheck }));
  scenario.on(route("PUT", "/api/system/kiwoom/registered-ip"), (request) => {
    const input: RegisteredIpInput = request.postDataJSON();
    const next = { ...scenario.live.kiwoomLink, registeredIp: { ip: input.ip, at: Math.floor(scenario.now / 1000) } };
    scenario.live.link(next);
    return { body: next };
  });
}

test("키를 바꾸는 중 키 출처가 .env로 바뀌면 마법사의 연결 카드가 돌아온다", async ({ page, scenario }) => {
  scenario.live.account = signedIn();
  scenario.live.kiwoomLink = { ...DISCONNECTED, atStart: "keptDisconnected" };
  answerIp(scenario);
  await page.addInitScript((key) => sessionStorage.setItem(key, "1"), LOGIN_MARKER);
  await page.goto("/");
  await wizard(page).getByRole("button", { name: "내 공인 IP 확인" }).click();
  await wizard(page).getByLabel("포털에 지금 공인 IP를 등록했습니다").check();
  await wizard(page).getByRole("button", { name: "다음" }).click();
  const connect = wizard(page).getByRole("button", { name: "키움에 연결" });
  await expect(connect).toBeVisible();
  await wizard(page).getByRole("region", { name: "키움 키" }).getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(connect).toHaveCount(0);
  scenario.live.link({ ...DISCONNECTED, keySource: "env", atStart: "keptDisconnected" });
  await expect(wizard(page)).toContainText(".env에서 읽음");
  await expect(connect).toBeVisible();
});
