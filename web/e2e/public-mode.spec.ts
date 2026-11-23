import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Ranking } from "../src/api/generated/Ranking";
import type { RankingPage } from "../src/api/generated/RankingPage";
import { flowSeries, HEATMAP_FLOWS, HEATMAP_TABLE, seedHeatmapFlow, seedHeatmapThemes } from "./fixtures/heatmap-data";
import type { PublicSession } from "./fixtures/public-mode-data";
import { isRankingRequest, rankingCalls, rankingRows, serveRankings } from "./fixtures/ranking-data";
import { DEFAULT_LAYOUT_ID, expect, test, windowTab, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const SESSION: PublicSession = { provider: "google", createdAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 };
const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } as const;
const TRADE_AMOUNT: Ranking = { kind: "tradeAmount", market: "all", venue: "combined", excludes: { etfEtn: true, preferred: false }, excludeManaged: false };
const EMPTY_TITLE = "실시간·차트 연결은 준비 중입니다";
const KST_MINUTE_MS = 60_000;

const landing = (page: Page) => page.getByTestId("landing");
const loginDialog = (page: Page) => page.getByRole("dialog", { name: "로그인", exact: true });
const settings = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const flowLine = (page: Page) => main(page).locator(".hm-flow-line");
const callsTo = (scenario: Scenario, method: string, pathname: string) => scenario.requests.filter((r) => r.method() === method && new URL(r.url()).pathname === pathname);
const pathOf = (request: { url(): string }) => new URL(request.url()).pathname;

function listenerOnlyForbidden(scenario: Scenario) {
  const forbidden = scenario.requests.map(pathOf).filter((p) => p.startsWith("/api/bars") || p === "/api/quotes" || p.startsWith("/api/system/") || p.startsWith("/api/account") || p.startsWith("/api/trading/"));
  expect(forbidden).toEqual([]);
  expect(scenario.live.opened).toBe(0);
}

function layoutWith(scenario: Scenario, extra: LayoutWindow[]) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chart: LayoutWindow = { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS };
  const windows = [chart, ...extra, ...layout.windows.filter((w) => w.kind !== "chart")];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

const rankingWindow = (): LayoutWindow => ({ id: "ranking", link: null, kind: "ranking", ranking: TRADE_AMOUNT });

async function openAccountMenu(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await settings(page).getByRole("tab", { name: "계정", exact: true }).click();
}

async function addToWatchlist(page: Page, query: string, code: string) {
  const panel = page.getByRole("complementary", { name: "관심종목" });
  await panel.getByRole("button", { name: "관심종목에 넣기" }).click();
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(query);
  await dialog.getByRole("option").filter({ hasText: code }).first().click();
  await expect(panel.locator(`li[data-code="${code}"]`)).toBeVisible();
}

test.describe("로그인 전", () => {
  for (const [provider, label] of [["google", "Google"], ["naver", "네이버"]] as const) {
    test(`${label} 단추는 브라우저 로그인 시작 경로로 최상위 이동한다`, async ({ page, scenario }) => {
      scenario.publicMode.enable(null);
      await page.goto("/");
      await expect(landing(page)).toBeVisible();
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      const started = page.waitForRequest((request) => pathOf(request) === `/v1/session/${provider}/start`);
      await page.getByRole("button", { name: `${label}로 로그인` }).click();
      const request = await started;
      expect(request.isNavigationRequest()).toBe(true);
      expect(request.frame()).toBe(page.mainFrame());
      expect(request.method()).toBe("GET");
      expect(callsTo(scenario, "POST", "/api/account/login")).toHaveLength(0);
    });
  }

  test("로그인 전에는 세션만 확인하고 사용자 자료와 시세를 읽지 않는다", async ({ page, scenario }) => {
    scenario.publicMode.enable(null);
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "시스템 설정", exact: true })).toHaveCount(0);
    expect(callsTo(scenario, "GET", "/v1/session")).toHaveLength(1);
    expect(scenario.requests.map(pathOf).filter((p) => ["/api/layouts", "/api/watchlists", "/api/ui-state"].includes(p))).toEqual([]);
    listenerOnlyForbidden(scenario);
  });

  const FAILURES = [
    ["cancelled", "로그인을 취소했습니다"],
    ["idp_failed", "Google 또는 네이버가 로그인을 마치지 못했습니다"],
    ["account_limit", "새 계정을 더 받지 않습니다"],
    ["blocked", "이 계정은 쓸 수 없습니다"],
  ] as const;
  for (const [reason, text] of FAILURES) {
    test(`로그인 실패 ${reason}는 문구를 보이고 주소의 질의를 지운다`, async ({ page, scenario }) => {
      scenario.publicMode.enable(null);
      await page.goto(`/?login=error&reason=${reason}`);
      await expect(loginDialog(page).getByRole("status")).toContainText(text);
      await expect(page).toHaveURL(/\/$/);
    });
  }

  test("첫 화면을 열 때 받은 바이트를 종류별로 기록한다", async ({ page, scenario }, testInfo) => {
    scenario.publicMode.enable(null);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const kinds = new Map<string, string>();
    const sizes = new Map<string, number>();
    cdp.on("Network.responseReceived", (event) => { kinds.set(event.requestId, event.type); });
    cdp.on("Network.loadingFinished", (event) => { sizes.set(event.requestId, event.encodedDataLength); });
    await page.goto("/");
    await expect(landing(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    const bytes = { document: 0, js: 0, css: 0, font: 0, other: 0, total: 0 };
    const group = { Document: "document", Script: "js", Stylesheet: "css", Font: "font" } as const;
    for (const [id, size] of sizes) {
      const key = group[kinds.get(id) as keyof typeof group] ?? "other";
      bytes[key] += size;
      bytes.total += size;
    }
    expect(bytes.js).toBeGreaterThan(0);
    expect(bytes.total).toBeGreaterThanOrEqual(bytes.js + bytes.document);
    const record = JSON.stringify({ screen: "공개 모드 로그인 전 첫 화면", unit: "byte", bytes }, null, 2);
    await testInfo.attach("first-load-bytes.json", { body: record, contentType: "application/json" });
    const folder = path.resolve("../target/public-mode");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "first-load-bytes.json"), record);
    console.log(`public-mode first-load-bytes ${JSON.stringify(bytes)}`);
  });
});

test.describe("로그인 뒤", () => {
  test.beforeEach(({ scenario }) => scenario.publicMode.enable(SESSION));

  test("관심종목을 저장하면 PUT /api/watchlists로 가고 실시간·차트 경로는 부르지 않는다", async ({ page, scenario }) => {
    await page.goto("/");
    await expect(page.getByRole("complementary", { name: "관심종목" })).toBeVisible();
    await addToWatchlist(page, "에코프로", "086520");
    await expect.poll(() => callsTo(scenario, "PUT", "/api/watchlists").length).toBeGreaterThan(0);
    expect(scenario.documents.watchlists().lists[0]!.symbols).toContain("086520");
    await expect(page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="086520"]')).not.toContainText(/\d{2,3},\d{3}/);
    listenerOnlyForbidden(scenario);
  });

  test("순위 창은 고정값을 보인다", async ({ page, scenario }) => {
    serveRankings(scenario, { rows: () => rankingRows(30), pageSize: 30 });
    layoutWith(scenario, [rankingWindow()]);
    await page.goto("/");
    await expect(page.getByTestId("ranking-row").first()).toBeVisible();
    await expect(page.locator('[data-testid=ranking-row][data-code="005930"]')).toBeVisible();
    listenerOnlyForbidden(scenario);
  });

  test("히트맵 페이지는 고정값을 보인다", async ({ page, scenario }) => {
    seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
    await page.goto("/heatmap");
    await expect(main(page).locator('.hm-tile[data-code="005930"]')).toHaveAccessibleName("삼성전자 +2.00%");
    listenerOnlyForbidden(scenario);
  });

  test("차트·호가·주문 창은 빈 상태를 보이고 오류 알림이 없다", async ({ page, scenario }) => {
    layoutWith(scenario, [{ id: "book", link: "a", kind: "book" }, { id: "order", link: "a", kind: "order", venue: "combined" }]);
    await page.goto("/");
    const empty = page.getByTestId("public-unavailable");
    await expect(empty.first()).toContainText(EMPTY_TITLE);
    for (const name of ["10호가", "호가주문"]) {
      await windowTab(page, name).click();
      await expect(empty.filter({ visible: true }).first()).toContainText(EMPTY_TITLE);
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
    listenerOnlyForbidden(scenario);
  });

  test("시스템 설정의 키움 영역은 브라우저 보관소 화면이고 키움 경로를 부르지 않는다", async ({ page, scenario }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
    await expect(settings(page).getByTestId("browser-keys")).toBeVisible();
    await expect(settings(page).getByRole("tab", { name: "일반" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    listenerOnlyForbidden(scenario);
  });

  test("로그아웃은 JSON 본문의 POST로 가고 랜딩으로 돌아간다", async ({ page, scenario }) => {
    await page.goto("/");
    await openAccountMenu(page);
    await expect(settings(page).getByText("Google")).toBeVisible();
    await settings(page).getByRole("button", { name: "로그아웃" }).click();
    await expect(landing(page)).toBeVisible();
    const [logout] = callsTo(scenario, "POST", "/v1/session/logout");
    expect(logout).toBeDefined();
    expect(await logout!.headerValue("content-type")).toContain("application/json");
    expect(scenario.publicMode.session).toBeNull();
  });

  test("계정 삭제는 확인을 받은 뒤 DELETE /v1/account로 간다", async ({ page, scenario }) => {
    await page.goto("/");
    await openAccountMenu(page);
    await settings(page).getByRole("button", { name: "계정 삭제", exact: true }).click();
    const confirm = settings(page).getByRole("region", { name: "계정 삭제" });
    await expect(confirm).toContainText("이 브라우저에 저장한 키움 키는 따로 지워야 합니다");
    expect(callsTo(scenario, "DELETE", "/v1/account")).toHaveLength(0);
    await confirm.getByRole("textbox").fill("계정 삭제");
    await confirm.getByRole("button", { name: "계정 삭제 실행" }).click();
    await expect(landing(page)).toBeVisible();
    const [removal] = callsTo(scenario, "DELETE", "/v1/account");
    expect(removal).toBeDefined();
    expect(await removal!.headerValue("content-type")).toContain("application/json");
  });

  test("로그인한 동안 API가 401 signed_out을 내면 랜딩으로 돌아간다", async ({ page, scenario }) => {
    await page.goto("/");
    const panel = page.getByRole("complementary", { name: "관심종목" });
    await expect(panel).toBeVisible();
    scenario.publicMode.session = null;
    await panel.getByRole("button", { name: "관심종목에 넣기" }).click();
    await page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" }).getByRole("combobox", { name: "종목 검색" }).fill("에코프로");
    await expect(landing(page)).toBeVisible();
    expect(callsTo(scenario, "GET", "/api/symbols").length).toBeGreaterThan(0);
  });

  test("순위 창의 요청은 5쪽을 넘지 않고 5쪽에서 멈춘다", async ({ page, scenario }) => {
    serveRankings(scenario, { rows: () => rankingRows(400), pageSize: 20 });
    layoutWith(scenario, [rankingWindow()]);
    await page.goto("/");
    const more = page.getByTestId("ranking-more");
    for (let pages = 1; pages < 5; pages++) {
      await expect(more).toBeEnabled();
      await more.click();
      await expect.poll(() => rankingCalls(scenario).length).toBe(pages + 1);
    }
    await expect(page.getByTestId("ranking-limited")).toBeVisible();
    await expect(more).toHaveCount(0);
    expect(Math.max(...rankingCalls(scenario).map((call) => call.pages))).toBe(5);
  });

  test("흐름은 KST 분이 바뀐 뒤 2~10초 사이에 다시 요청한다", async ({ page, scenario }) => {
    seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
    const asked = seedHeatmapFlow(scenario, HEATMAP_FLOWS);
    await page.clock.install({ time: scenario.now });
    await page.goto("/heatmap?view=flow");
    await expect(flowLine(page)).toHaveCount(2);
    const loaded = asked.length;
    const now = await page.evaluate(() => Date.now());
    const pausedAt = now + 1_000;
    await page.clock.pauseAt(pausedAt);
    const untilNextMinute = KST_MINUTE_MS - (pausedAt % KST_MINUTE_MS);
    await page.clock.runFor(untilNextMinute + 1_900);
    expect(asked).toHaveLength(loaded);
    await page.clock.runFor(8_200);
    await expect.poll(() => asked.length).toBe(loaded * 2);
  });

  test("흐름 응답의 테마 밖 종목은 빠진 종목으로 보인다", async ({ page, scenario }) => {
    seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
    seedHeatmapFlow(scenario, { ...HEATMAP_FLOWS, "005930,000660": flowSeries([0.5, 1.2], ["005930"], { notInThemes: ["000660"] }) });
    await page.goto("/heatmap?view=flow");
    await expect(main(page).getByText("반도체: 분봉을 받지 못해 평균에서 뺀 종목 SK하이닉스")).toBeVisible();
  });

  test("429의 retryAt이 지나기 전에는 같은 요청을 다시 보내지 않는다", async ({ page, scenario }) => {
    const retryAt = Math.floor(scenario.now / 1000) + 30;
    let answered = 0;
    scenario.on(isRankingRequest, () => {
      answered++;
      const page: RankingPage = { source: "kiwoom", rows: rankingRows(5), pages: 1, end: true, limited: false, hidden: 0, fetchedAt: Math.floor(scenario.now / 1000) };
      return answered === 1
        ? { status: 429, body: { error: { code: "kiwoom_unavailable", message: "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요", reason: "rate_limited", retryAt, manualActionRequired: false } } }
        : { body: page };
    });
    layoutWith(scenario, [rankingWindow()]);
    await page.clock.install({ time: scenario.now });
    await page.goto("/");
    const retry = page.getByRole("button", { name: "다시 받기" });
    await expect(retry).toBeVisible();
    expect(answered).toBe(1);
    await page.clock.runFor(10_000);
    await retry.click();
    await page.clock.runFor(1_000);
    expect(answered).toBe(1);
    await page.clock.runFor(21_000);
    await retry.click();
    await expect.poll(() => answered).toBe(2);
    await expect(page.getByTestId("ranking-row").first()).toBeVisible();
  });
});
