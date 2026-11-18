import type { Page } from "@playwright/test";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import { CONNECTED_KIWOOM } from "./fixtures/scenario";
import { readyStatus } from "./fixtures/screener";
import { cell, expect, test, type Scenario, pollSaved } from "./screener-harness";
import { openScreener, panel, results, rows, runButton, storeLine } from "./screener-page";

const NOT_CONNECTED = { status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움에 연결하지 않았습니다", reason: "not_connected", retryAt: null, manualActionRequired: false } } };
const statusBar = (page: Page) => page.locator("footer.status-bar");
const guide = (page: Page) => page.getByRole("region", { name: "키움 연결 안내" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const noHorizontalScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

const symbolRoute = (url: URL) => /^\/api\/symbols\/[^/]+$/.test(url.pathname);

function refuseNamesBeforeConnect(scenario: Scenario) {
  const state = { connected: false };
  scenario.on((url) => symbolRoute(url) && !state.connected, () => NOT_CONNECTED);
  return state;
}

function beforeConnect(scenario: Scenario, link: Partial<KiwoomLinkStatus>, realtime: "notConnected" | "live" = "notConnected") {
  scenario.live.kiwoomLink = { ...CONNECTED_KIWOOM, ...link };
  scenario.live.status({ realtime, since: Math.floor(scenario.now / 1000), backfilling: false });
  scenario.reply("/api/quotes", NOT_CONNECTED);
}

const noKey: Partial<KiwoomLinkStatus> = { state: "noKey", keySource: "none", appKeyTail: null, message: "키움 키가 없습니다" };
const disconnected: Partial<KiwoomLinkStatus> = { state: "disconnected", message: "키움에 연결하지 않았습니다" };
const blocked: Partial<KiwoomLinkStatus> = { state: "failed", problem: "authBlocked8050", message: "키움이 지정단말기 인증을 거절했습니다" };

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toBeVisible();
}

test("키 없음: 차트 칸 카드의 단추가 키움 연결 내용을 열고 상태 줄은 회색이다", async ({ page, scenario }) => {
  beforeConnect(scenario, noKey);
  await open(page);
  await expect(guide(page).getByRole("heading", { name: "키움 키를 넣으면 시세가 보입니다" })).toBeVisible();
  await expect(statusBar(page).getByRole("button", { name: /키움 키가 없습니다/ }).locator(".conn-dot")).toHaveAttribute("data-tone", "gray");
  await expect(statusBar(page)).not.toHaveClass(/danger/);
  await guide(page).getByRole("button", { name: "시스템 설정 열기" }).click();
  await expect(dialog(page).getByRole("tab", { name: /^키움 연결/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog(page).getByRole("tabpanel")).toContainText("키움 키가 없습니다");
});

test("연결 안 함: 관심종목은 보이고 가격은 —, 검색은 연결 안내, 스크리너 업데이트는 꺼진다", async ({ page, scenario, screener }) => {
  beforeConnect(scenario, disconnected);
  refuseNamesBeforeConnect(scenario);
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: ["005930"] } : list)), revision: lists.revision + 1 });
  screener.showStatus(readyStatus());
  scenario.documents.saveScreens({ screens: [{ id: "high", name: "고점", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", field: "close", n: 60, recentBars: 1 }] }], revision: 1 });
  await open(page);
  await expect(guide(page).getByRole("heading", { name: "키움에 연결하지 않았습니다" })).toBeVisible();

  const watch = page.getByRole("complementary", { name: "관심종목" });
  await expect(watch.getByText("저장된 목록 · 시세 없음")).toBeVisible();
  const row = watch.locator('li[data-code="005930"]');
  await expect(row.locator("[data-main]")).toHaveAccessibleName("005930");
  await expect(row.getByText("—").first()).toBeVisible();

  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색" });
  await expect(search.getByText("키움에 연결하면 검색할 수 있습니다")).toBeVisible();
  await expect(search.getByRole("button", { name: "연결", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await openScreener(page);
  await expect(panel(page).getByText(/^저장된 일봉 \d\d\/\d\d까지/)).toBeVisible();
  await expect(storeLine(page).getByRole("button", { name: /^업데이트/ })).toBeDisabled();
  await expect(storeLine(page).getByRole("button", { name: /^업데이트/ })).toHaveText("연결 뒤");
  await runButton(page).click();
  await expect(results(page)).toHaveAttribute("aria-busy", "false");
  await expect(rows(page).first()).toBeVisible();
});

test("8050: 상태 줄이 붉고 시스템 설정으로 이끌며 누르면 키움 연결 내용이 열린다", async ({ page, scenario }) => {
  beforeConnect(scenario, blocked);
  await open(page);
  const sentence = statusBar(page).getByRole("button", { name: "키움 인증 차단: 시스템 설정에서 확인하세요" });
  await expect(sentence).toBeVisible();
  await expect(sentence.locator(".conn-dot")).toHaveAttribute("data-tone", "red");
  await expect(statusBar(page)).toHaveClass(/danger/);
  await sentence.click();
  await expect(dialog(page).getByRole("tabpanel")).toContainText("키움이 지정단말기 인증을 거절했습니다");
});

const connectCalls = (scenario: Scenario) => scenario.requests.filter((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/system/kiwoom/connect");
const waitingLink = (scenario: Scenario, seconds: number): Partial<KiwoomLinkStatus> => ({ state: "connecting", step: "issueInterval", retryAt: Math.floor(scenario.now / 1000) + seconds, message: "발급 간격을 기다립니다" });

test("연결 안 함(끊어 둠): 차트 카드의 연결이 acknowledged false로 한 번 나가고 시스템 설정은 열리지 않는다", async ({ page, scenario }) => {
  beforeConnect(scenario, { ...disconnected, atStart: "keptDisconnected" });
  scenario.on((url, request) => url.pathname === "/api/system/kiwoom/connect" && request.method() === "POST", () => ({ body: { ...CONNECTED_KIWOOM } }));
  await open(page);
  await expect(guide(page)).toContainText("연결하면 다음부터 서버를 켤 때 자동으로 연결합니다");
  await expect(statusBar(page)).toContainText("연결을 끊어 두었습니다");
  await guide(page).getByRole("button", { name: "연결", exact: true }).click();
  await pollSaved(() => connectCalls(scenario).length).toBe(1);
  expect(connectCalls(scenario)[0]!.postDataJSON()).toEqual({ acknowledged: false });
  await expect(dialog(page)).toHaveCount(0);
});

test("연결 안 함(시작 때 연결): 상태 줄의 키움에 연결 단추도 같다", async ({ page, scenario }) => {
  beforeConnect(scenario, { ...disconnected, atStart: "connects" });
  scenario.on((url, request) => url.pathname === "/api/system/kiwoom/connect" && request.method() === "POST", () => ({ body: { ...CONNECTED_KIWOOM } }));
  await open(page);
  await expect(statusBar(page)).toContainText("키는 저장됨 · 연결하지 않았습니다");
  await statusBar(page).getByRole("button", { name: "키움에 연결" }).click();
  await pollSaved(() => connectCalls(scenario).length).toBe(1);
  expect(connectCalls(scenario)[0]!.postDataJSON()).toEqual({ acknowledged: false });
  await expect(dialog(page)).toHaveCount(0);
});

test("대기 단계: 상태 줄과 카드에 남은 시간이 보이고 줄며 연결 요청은 나가지 않는다", async ({ page, scenario }) => {
  beforeConnect(scenario, waitingLink(scenario, 400));
  await open(page);
  await expect(statusBar(page)).toContainText(/발급 간격 대기 · \d:\d\d 뒤 저절로 연결/);
  await expect(guide(page)).toContainText(/발급 간격 대기 · \d:\d\d 뒤 저절로 연결/);
  await expect(guide(page)).toContainText("기다리는 동안 키움에 아무것도 보내지 않습니다");
  await expect(guide(page).getByRole("button")).toHaveCount(0);
  await expect(statusBar(page).getByRole("button", { name: "키움에 연결" })).toHaveCount(0);
  const first = await statusBar(page).innerText();
  await expect.poll(async () => (await statusBar(page).innerText()) !== first, { timeout: 4000 }).toBe(true);
  expect(connectCalls(scenario)).toHaveLength(0);
});

test("네트워크 실패: 간격 뒤에는 다시 시도, 간격 안에서는 비활성 남은 시간 단추다", async ({ page, scenario }) => {
  const net: Partial<KiwoomLinkStatus> = { state: "failed", problem: "network", message: "키움에 닿지 못했습니다" };
  beforeConnect(scenario, { ...net, retryAt: Math.floor(scenario.now / 1000) + 300 });
  await open(page);
  await expect(statusBar(page).getByRole("button", { name: /\d:\d\d 뒤 다시 시도/ })).toBeDisabled();
  await expect(guide(page).getByRole("button", { name: /\d:\d\d 뒤 다시 시도/ })).toBeDisabled();
  scenario.live.link({ ...CONNECTED_KIWOOM, ...net, retryAt: null });
  await expect(statusBar(page).getByRole("button", { name: "다시 시도" })).toBeEnabled();
  await expect(guide(page).getByRole("button", { name: "다시 시도" })).toBeEnabled();
});

test("8050: 상태 줄과 카드에 연결 단추가 없고 시스템 설정으로 이끈다", async ({ page, scenario }) => {
  beforeConnect(scenario, blocked);
  await open(page);
  await expect(statusBar(page).getByRole("button", { name: /^(키움에 연결|연결|다시 시도)$/ })).toHaveCount(0);
  await expect(guide(page).getByRole("button", { name: /^(연결|다시 시도)$/ })).toHaveCount(0);
  await expect(guide(page).getByRole("button", { name: "시스템 설정 열기" })).toBeVisible();
});

test("연결됨 상태 메시지가 오면 카드가 사라지고 기존 화면으로 돌아온다", async ({ page, scenario }) => {
  beforeConnect(scenario, disconnected);
  await open(page);
  await expect(guide(page)).toBeVisible();
  scenario.reply("/api/quotes", { body: [] });
  scenario.live.status({ realtime: "live", since: Math.floor(scenario.now / 1000), backfilling: false });
  scenario.live.link({ ...CONNECTED_KIWOOM });
  await expect(guide(page)).toHaveCount(0);
  await expect(statusBar(page).getByRole("button", { name: /실시간 연결됨|장 닫힘/ })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "관심종목" }).getByText("저장된 목록 · 시세 없음")).toHaveCount(0);
});

test("연결되면 코드로 남았던 관심종목 줄이 종목 이름을 다시 받는다", async ({ page, scenario }) => {
  beforeConnect(scenario, disconnected);
  const names = refuseNamesBeforeConnect(scenario);
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: ["005930"] } : list)), revision: lists.revision + 1 });
  await open(page);
  const row = page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="005930"]');
  await expect(row.locator("[data-main]")).toHaveAccessibleName("005930");
  names.connected = true;
  scenario.reply("/api/quotes", { body: [] });
  scenario.live.status({ realtime: "live", since: Math.floor(scenario.now / 1000), backfilling: false });
  scenario.live.link({ ...CONNECTED_KIWOOM });
  await expect(row.locator("[data-main]")).toHaveAccessibleName("삼성전자");
});

test("연결 중 다른 이유로 실패한 차트도 연결됨이 되면 다시 받는다", async ({ page, scenario }) => {
  beforeConnect(scenario, { state: "connecting" });
  let failing = true;
  const requests: string[] = [];
  scenario.on((url) => url.pathname === "/api/bars" && failing, (request) => {
    requests.push(request.url());
    return { status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움에 닿지 못했습니다", reason: "kiwoom_unreachable", retryAt: null, manualActionRequired: false } } };
  });
  await open(page);
  await expect(guide(page).getByRole("heading", { name: "키움에 연결하는 중입니다" })).toBeVisible();
  await expect(guide(page).getByRole("button")).toHaveCount(0);
  failing = false;
  scenario.reply("/api/quotes", { body: [] });
  scenario.live.link({ ...CONNECTED_KIWOOM });
  await expect(guide(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
});

test("연결 안 함에서 검색 창은 Enter로 숨은 종목을 열지 않는다", async ({ page, scenario }) => {
  beforeConnect(scenario, disconnected);
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: ["000810"] } : list)), revision: lists.revision + 1 });
  await open(page);
  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색" });
  await expect(search.getByText("키움에 연결하면 검색할 수 있습니다")).toBeVisible();
  await expect(search.getByRole("combobox", { name: "종목 검색" })).toHaveAttribute("aria-expanded", "false");
  await expect(search.getByRole("combobox", { name: "종목 검색" })).not.toHaveAttribute("aria-controls");
  await page.keyboard.press("Enter");
  await expect(search).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-label", /삼성전자/);
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("키 없음 카드가 가로 스크롤 없이 보인다", async ({ page, scenario }) => {
    beforeConnect(scenario, noKey);
    await open(page);
    await expect(guide(page).getByRole("button", { name: "시스템 설정 열기" })).toBeVisible();
    await noHorizontalScroll(page);
    const box = await guide(page).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  });
});

test.describe("360px 폭 연결 단추", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("끊어 둠 카드와 헤더의 연결 단추가 가로 스크롤 없이 보인다", async ({ page, scenario }) => {
    beforeConnect(scenario, { ...disconnected, atStart: "keptDisconnected" });
    await open(page);
    await expect(guide(page).getByRole("button", { name: "연결", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "키움에 연결" })).toBeVisible();
    await noHorizontalScroll(page);
    const box = await page.getByRole("button", { name: "키움에 연결" }).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  });
});

test("긴 서버 문장도 차트 칸이 낮을 때 안내 단추가 눌린다", async ({ page, scenario }) => {
  beforeConnect(scenario, { state: "failed", problem: "authUncertain", message: "키움이 지정단말기 인증을 거절했습니다 ".repeat(8) });
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page);
  const button = guide(page).getByRole("button", { name: "시스템 설정 열기" });
  await expect(button).toBeVisible();
  const [card, chart] = await Promise.all([guide(page).boundingBox(), cell(page).boundingBox()]);
  expect(card!.y + card!.height).toBeLessThanOrEqual(chart!.y + chart!.height + 1);
  await button.click();
  await expect(dialog(page)).toBeVisible();
});
