import type { Page } from "@playwright/test";
import type { ApiError } from "../src/api/generated/ApiError";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { cell, DEFAULT_LAYOUT_ID, expect, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const NOT_CONNECTED = { status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움에 연결하지 않았습니다", reason: "not_connected", retryAt: null, manualActionRequired: false } } };
const stopped: ApiError = { error: { code: "kiwoom_auth_failed", message: "인증에 실패했습니다 [8050] 지정단말기 인증에 실패했습니다", reason: "auth_blocked", retryAt: null, manualActionRequired: true } };

const banner = (page: Page) => page.getByTestId("shell-banner");
const footer = (page: Page) => page.getByRole("contentinfo");
const guide = (page: Page) => page.getByRole("region", { name: "키움 연결 안내" });
const workspace = (page: Page) => page.getByRole("main", { name: "작업 영역" });

const layoutSave = (url: URL, request: { method(): string }) => url.pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && request.method() === "PUT";

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

function failLayoutSaves(scenario: Scenario) {
  scenario.on(layoutSave, () => ({ status: 503, body: { error: { code: "internal", message: "저장 연결 끊김" } } }));
}

async function changePeriod(page: Page) {
  await page.getByRole("button", { name: "주", exact: true }).first().click();
}

function beforeConnect(scenario: Scenario, link: Partial<KiwoomLinkStatus>) {
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, ...link };
  scenario.live.status({ realtime: "notConnected", since: Math.floor(scenario.now / 1000), backfilling: false });
  scenario.reply("/api/quotes", NOT_CONNECTED);
}

test("저장이 실패하면 위 막대 아래에 띠가 보이고 테두리 있는 다시 시도가 저장을 다시 한다", async ({ page, scenario }) => {
  await open(page);
  failLayoutSaves(scenario);
  await changePeriod(page);
  await expect(banner(page)).toContainText("저장하지 못했습니다");
  const bar = (await page.getByRole("toolbar", { name: "차트 도구 막대" }).boundingBox())!;
  const box = (await banner(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(box.height).toBe(32);
  await expect(footer(page)).toContainText("저장 실패");
  const retry = banner(page).getByRole("button", { name: "다시 시도" });
  await expect(retry).toHaveCSS("border-top-width", "1px");
  scenario.on(layoutSave, (request) => ({ body: scenario.documents.saveLayout(request.postDataJSON()) }));
  await retry.click();
  await expect(banner(page)).toHaveCount(0);
  await expect(footer(page)).toContainText("저장됨");
});

test("서버에 닿지 못해 기본 화면으로 열면 띠가 저장되지 않는다고 말하고 알림이 사라진 뒤에도 남는다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  scenario.reply("/api/ui-state", { status: 503, body: { error: { code: "internal", message: "연결 끊김" } } });
  await page.goto("/");
  await expect(banner(page)).toContainText("바꾼 것은 저장되지 않습니다");
  const toast = page.getByRole("status").filter({ hasText: "서버에 연결하지 못해 기본 화면으로 열었습니다" });
  await expect(toast.first()).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(toast).toHaveCount(0);
  await expect(banner(page)).toContainText("바꾼 것은 저장되지 않습니다");
});

test("띠가 떠도 작업 영역 묶음의 위치와 크기는 변하지 않는다", async ({ page, scenario }) => {
  await open(page);
  const groups = page.locator("[data-dock-group]");
  const before = { area: await workspace(page).boundingBox(), first: await groups.nth(0).boundingBox(), second: await groups.nth(1).boundingBox() };
  failLayoutSaves(scenario);
  await changePeriod(page);
  await expect(banner(page)).toBeVisible();
  expect({ area: await workspace(page).boundingBox(), first: await groups.nth(0).boundingBox(), second: await groups.nth(1).boundingBox() }).toEqual(before);
});

test("키움 조회 멈춤은 상태 줄에 짧은 문장만 두고 오류 코드는 자세히 안에 둔다", async ({ page, scenario }) => {
  scenario.reply("/api/bars", { status: 503, body: stopped });
  await page.goto("/");
  await expect(banner(page)).toContainText("키움 조회가 멈췄습니다");
  const sentence = footer(page).getByRole("status").first();
  await expect(sentence).toContainText("키움 조회 멈춤");
  expect(((await sentence.textContent()) ?? "").length).toBeLessThanOrEqual(60);
  await expect(footer(page)).not.toContainText("8050");
  await expect(banner(page)).not.toContainText("8050");
  await banner(page).getByRole("button", { name: "자세히" }).click();
  await expect(page.getByRole("dialog", { name: "자세히" })).toContainText("[8050]");
});

test("연결된 평소 상태에서는 2초 동안 상태 줄의 DOM이 바뀌지 않는다", async ({ page, scenario }) => {
  await page.clock.install({ time: scenario.now });
  await open(page);
  await expect(footer(page).getByLabel("장 상태와 서버 시계")).toContainText("장중");
  await expect(async () => {
    await page.clock.runFor(500);
    await expect(footer(page)).toContainText("저장됨", { timeout: 200 });
  }).toPass();
  await page.evaluate(() => {
    const target = document.querySelector("footer.status-bar")!;
    const w = window as unknown as { __statusMutations: number };
    w.__statusMutations = 0;
    new MutationObserver((records) => { w.__statusMutations += records.length; }).observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => (window as unknown as { __statusMutations: number }).__statusMutations)).toBe(0);
});

test("키 없음 연결 전 카드는 세 걸음과 키 등록 시작을 보이고 8050 카드는 제목에 8050을 말하며 연결 단추가 없다", async ({ page, scenario }) => {
  beforeConnect(scenario, { state: "noKey", keySource: "none", appKeyTail: null, message: "키움 키가 없습니다" });
  await open(page);
  await expect(guide(page).getByRole("list", { name: "시작 순서" }).getByRole("listitem")).toHaveCount(3);
  await expect(guide(page).getByRole("button", { name: "키 등록 시작" })).toBeVisible();
  expect((await guide(page).boundingBox())!.width).toBeLessThanOrEqual(440);

  beforeConnect(scenario, { state: "failed", problem: "authBlocked8050", message: "키움이 지정단말기 인증을 거절했습니다" });
  await page.reload();
  await expect(guide(page).getByRole("heading", { name: /8050/ })).toBeVisible();
  await expect(guide(page).getByRole("button", { name: /연결|다시 시도/ })).toHaveCount(0);
});

test.describe("휴대폰", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("저장 실패 띠는 불투명한 면이다", async ({ page, scenario }) => {
    scenario.reply("/api/ui-state", { status: 503, body: { error: { code: "internal", message: "연결 끊김" } } });
    await page.goto("/");
    const band = page.getByTestId("phone-save-band");
    await expect(band).toBeVisible();
    const background = await band.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(background).not.toMatch(/\/|rgba|transparent/);
  });
});
