import { CONNECTED_KIWOOM, DEFAULT_SYSTEM_SETTINGS } from "./fixtures/scenario";
import type { KiwoomEnvironment } from "../src/api/generated/KiwoomEnvironment";
import type { KiwoomLinkStatus } from "../src/api/generated/KiwoomLinkStatus";
import { DEFAULT_ORDER_SETTINGS } from "../src/features/order/orderSettings";
import { cell, expect, pickDesktopVenue, test, type Scenario, pollSaved } from "./harness";
import { cellAt, feedSubscriptions, openOrderWindow, ordersOn, status, tradingApi, venueScene, win, writesTo } from "./order-window";

const DISCONNECTED: KiwoomLinkStatus = { ...CONNECTED_KIWOOM, state: "disconnected", message: "키가 저장돼 있습니다. 연결하지 않았습니다", realtimeRegistered: null, symbolCount: null };
const KRX_ONLY = "모의투자는 KRX 주문만 됩니다";
const UNSUPPORTED = "모의투자에서 지원하지 않는 기능입니다";

function environmentIs(scenario: Scenario, environment: KiwoomEnvironment, link: KiwoomLinkStatus = CONNECTED_KIWOOM): void {
  scenario.live.kiwoomLink = { ...link, environment };
  scenario.reply((url) => url.pathname === "/api/system/settings", { body: { ...DEFAULT_SYSTEM_SETTINGS, environment } });
}

const routes = (page: import("@playwright/test").Page) => page.getByTestId("order-settings").getByRole("group", { name: "주문 경로" });
const routeButton = (page: import("@playwright/test").Page) => page.getByTestId("order-settings-button");

async function openRoutes(page: import("@playwright/test").Page): Promise<void> {
  await routeButton(page).click();
  await expect(page.getByTestId("order-settings")).toBeVisible();
}

for (const [name, link] of [["키움 연결됨", CONNECTED_KIWOOM], ["키움 연결 전", DISCONNECTED]] as const) {
  test(`모의: 상단 "모의투자" 표시와 탭 제목 [모의]가 ${name}에서 보인다`, async ({ page, scenario }) => {
    environmentIs(scenario, "mock", link);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("toolbar", { name: "차트 도구 막대" }).getByText("모의투자", { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/^\[모의\] /);
  });
}

test("실전: 모의 표시가 없고 탭 제목에 [모의]가 없다", async ({ page, scenario }) => {
  environmentIs(scenario, "real");
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("모의투자", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveTitle(/\[모의\]/);
});

test("모의: 계좌 띠의 모의 표시, 설정의 경로 SOR·NXT 끔과 안내, 설정 값이 NXT여도 KRX로 보낸다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock");
  ordersOn(scenario);
  const api = tradingApi(scenario);
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), orderSettings: { ...DEFAULT_ORDER_SETTINGS, venue: "nxt" } });
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("account-mock")).toHaveText("모의");
  await expect(routeButton(page)).toContainText("KRX");
  await openRoutes(page);
  await expect(routes(page).getByRole("button", { name: "SOR" })).toBeDisabled();
  await expect(routes(page).getByRole("button", { name: "NXT" })).toBeDisabled();
  await expect(routes(page).getByRole("button", { name: "KRX" })).toBeEnabled();
  await expect(routes(page).getByRole("button", { name: "KRX" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("order-route-note")).toHaveText(KRX_ONLY);
  await expect(win(page)).toHaveAttribute("data-venue", "krx");
  await page.keyboard.press("Escape");

  await cellAt(page, "buy", 70_000).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body.venue).toBe("krx");
  expect(scenario.documents.uiState()["orderSettings"]).toMatchObject({ venue: "nxt" });
});

test("모의: 주문 경로 SOR·NXT는 꺼진 채로이고 시세는 위 막대 거래소를 따른다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock");
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  venueScene(scenario, { nxt: 65_000 });
  await expect(win(page)).toHaveAttribute("data-quote-venue", "combined");
  await pickDesktopVenue(page, "NXT");
  await pollSaved(() => feedSubscriptions(scenario, "trades", "nxt").length).toBe(2);
  await expect(win(page)).toHaveAttribute("data-quote-venue", "nxt");
  await expect(win(page)).toHaveAttribute("data-venue", "krx");
  expect(feedSubscriptions(scenario, "trades", "krx")).toHaveLength(0);
  await expect(page.getByTestId("price-ladder").locator(".mw-px-num").first()).toHaveText("66,000");
  await openRoutes(page);
  await expect(routes(page).getByRole("button", { name: "SOR" })).toBeDisabled();
  await expect(routes(page).getByRole("button", { name: "NXT" })).toBeDisabled();
});

test("모의: 서버가 mock_krx_only로 거절하면 상태 줄이 KRX 주문만 됨을 알린다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock");
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.placeReply = { state: "rejected", reason: "mock_krx_only", orderNo: null };
  await openOrderWindow(page, scenario);
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText(`거절 · ${KRX_ONLY}`);
});

test("모의: 사유 unsupported 응답을 받은 주문창이 모의 문구를 보인다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock");
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  scenario.on((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST", () => ({ status: 400, body: { error: { code: "bad_request", message: "키움이 지원하지 않는 요청입니다", reason: "unsupported", retryAt: null, manualActionRequired: false } } }));
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText(`거절 · ${UNSUPPORTED}`);
});

test("실전: 같은 unsupported 응답은 서버 문구 그대로이고 경로 세 값이 모두 켜져 있다", async ({ page, scenario }) => {
  environmentIs(scenario, "real");
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await expect(page.getByTestId("account-mock")).toHaveCount(0);
  await openRoutes(page);
  await expect(page.getByTestId("order-route-note")).toHaveCount(0);
  for (const label of ["SOR", "KRX", "NXT"]) await expect(routes(page).getByRole("button", { name: label })).toBeEnabled();
  await page.keyboard.press("Escape");
  scenario.on((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST", () => ({ status: 400, body: { error: { code: "bad_request", message: "키움이 지원하지 않는 요청입니다", reason: "unsupported", retryAt: null, manualActionRequired: false } } }));
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("거절 · 키움이 지원하지 않는 요청입니다");
});

async function openKiwoomTab(page: import("@playwright/test").Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  await expect(dialog).toBeVisible();
  return dialog.getByRole("tabpanel");
}

test("모의: 시스템 설정 키움 탭에 키 입력 칸이 없고 안내와 투자구분이 보인다", async ({ page, scenario }) => {
  environmentIs(scenario, "mock", { ...DISCONNECTED, keySource: "env", appKeyTail: "MOCK" });
  const panel = await openKiwoomTab(page);
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("listitem")).toContainText("모의투자");
  await expect(panel.getByRole("button", { name: "＋ 계좌 연결 더하기" })).toHaveCount(0);
  await expect(panel.getByTestId("mock-key-notice")).toHaveText("모의투자 키는 환경 설정(VALLY_KIWOOM_MOCK_APP_KEY)에서만 받습니다");
  await expect(panel.getByTestId("kiwoom-environment")).toContainText("모의투자");
  await expect(page.getByLabel("앱키", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("시크릿", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "저장" })).toHaveCount(0);
});

test("실전: 시스템 설정 키움 탭에 키 입력 칸이 있고 모의 표시가 없다", async ({ page, scenario }) => {
  environmentIs(scenario, "real", { ...DISCONNECTED, keySource: "none", appKeyTail: null, state: "noKey" });
  const panel = await openKiwoomTab(page);
  await expect(page.getByLabel("앱키", { exact: true })).toBeVisible();
  await expect(panel.getByTestId("mock-key-notice")).toHaveCount(0);
  await expect(panel.getByTestId("kiwoom-environment")).toHaveCount(0);
});
