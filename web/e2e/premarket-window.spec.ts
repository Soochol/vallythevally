import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { PreMarketDaySeries } from "../src/api/generated/PreMarketDaySeries";
import type { PreMarketSnapshot } from "../src/api/generated/PreMarketSnapshot";
import { cell, DEFAULT_LAYOUT_ID, expect, pollSaved, type Scenario, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const tabOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"]`);

const SAMSUNG_SERIES: Readonly<Record<string, PreMarketDaySeries>> = {
  "20261120": {
    date: "20261120",
    source: "store",
    points: [
      { secOfDay: 30600, expectedPriceWon: 70000, expectedReturnPct: 0.0, expectedQty: 10000, expectedTurnoverMillionWon: 700 },
      { secOfDay: 32000, expectedPriceWon: 74200, expectedReturnPct: 6.0, expectedQty: 40000, expectedTurnoverMillionWon: 2968 },
      { secOfDay: 32390, expectedPriceWon: 70700, expectedReturnPct: 1.0, expectedQty: 15000, expectedTurnoverMillionWon: 1060.5 },
    ],
    lateDropPct: -5.0,
    classification: "spoofWarning",
    openPriceWon: 70700,
    return0900Pct: 1.0,
    return0905Pct: 0.0,
    return0910Pct: -1.0,
  },
  "20261121": {
    date: "20261121",
    source: "store",
    points: [
      { secOfDay: 30600, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 12000, expectedTurnoverMillionWon: 856.8 },
      { secOfDay: 32000, expectedPriceWon: 72100, expectedReturnPct: 3.0, expectedQty: 30000, expectedTurnoverMillionWon: 2163 },
      { secOfDay: 32390, expectedPriceWon: 72450, expectedReturnPct: 3.5, expectedQty: 35000, expectedTurnoverMillionWon: 2535.75 },
    ],
    lateDropPct: 0.5,
    classification: "genuineGap",
    openPriceWon: 72450,
    return0900Pct: 3.5,
    return0905Pct: 4.5,
    return0910Pct: 5.0,
  },
  "20261122": {
    date: "20261122",
    source: "store",
    points: [
      { secOfDay: 30600, expectedPriceWon: 70200, expectedReturnPct: 0.3, expectedQty: 8000, expectedTurnoverMillionWon: 561.6 },
      { secOfDay: 32000, expectedPriceWon: 70350, expectedReturnPct: 0.5, expectedQty: 10000, expectedTurnoverMillionWon: 703.5 },
      { secOfDay: 32390, expectedPriceWon: 70140, expectedReturnPct: 0.2, expectedQty: 9000, expectedTurnoverMillionWon: 631.26 },
    ],
    lateDropPct: -0.3,
    classification: "flat",
    openPriceWon: 70140,
    return0900Pct: 0.2,
    return0905Pct: 0.0,
    return0910Pct: 0.1,
  },
  "20261123": {
    date: "20261123",
    source: "store",
    points: [
      { secOfDay: 30600, expectedPriceWon: 71050, expectedReturnPct: 1.5, expectedQty: 15000, expectedTurnoverMillionWon: 1065.75 },
      { secOfDay: 32000, expectedPriceWon: 72800, expectedReturnPct: 4.0, expectedQty: 25000, expectedTurnoverMillionWon: 1820 },
      { secOfDay: 32390, expectedPriceWon: 72800, expectedReturnPct: 4.0, expectedQty: 28000, expectedTurnoverMillionWon: 2038.4 },
    ],
    lateDropPct: 0.0,
    classification: "genuineGap",
    openPriceWon: 72800,
    return0900Pct: 4.0,
    return0905Pct: 4.2,
    return0910Pct: 4.8,
  },
};

const HYNIX_SERIES: Readonly<Record<string, PreMarketDaySeries>> = {
  "20261123": {
    date: "20261123",
    source: "store",
    points: [
      { secOfDay: 30600, expectedPriceWon: 204000, expectedReturnPct: 2.0, expectedQty: 15000, expectedTurnoverMillionWon: 3060 },
      { secOfDay: 32390, expectedPriceWon: 208000, expectedReturnPct: 4.0, expectedQty: 22000, expectedTurnoverMillionWon: 4576 },
    ],
    lateDropPct: 0.0,
    classification: "genuineGap",
    openPriceWon: 208000,
    return0900Pct: 4.0,
    return0905Pct: 5.0,
    return0910Pct: 6.0,
  },
};

const SNAPSHOTS: Readonly<Record<string, PreMarketSnapshot>> = {
  "20261124": {
    date: "20261124",
    availableDates: ["20261123", "20261124"],
    source: "flow",
    rows: [
      {
        code: "005930",
        name: "삼성전자",
        expectedPriceWon: 71400,
        expectedReturnPct: 2.0,
        expectedTurnoverMillionWon: 1500,
        lateDropPct: -3.2,
        signal: "spoofWarning",
        preMarketExtended: false,
        actual0900Pct: null,
        actual0910Pct: null,
      },
    ],
  },
  "20261123": {
    date: "20261123",
    availableDates: ["20261123", "20261124"],
    source: "store",
    rows: [
      {
        code: "005930",
        name: "삼성전자",
        expectedPriceWon: 70700,
        expectedReturnPct: 1.0,
        expectedTurnoverMillionWon: 1060.5,
        lateDropPct: -5.0,
        signal: "spoofWarning",
        preMarketExtended: false,
        actual0900Pct: 1.0,
        actual0910Pct: -1.0,
      },
      {
        code: "000660",
        name: "SK하이닉스",
        expectedPriceWon: 208000,
        expectedReturnPct: 4.0,
        expectedTurnoverMillionWon: 4576,
        lateDropPct: 0.0,
        signal: "genuineGap",
        preMarketExtended: true,
        actual0900Pct: 4.0,
        actual0910Pct: 6.0,
      },
    ],
  },
};

function setupPreMarketMocks(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  scenario.on(
    (url) => /^\/api\/symbols\/[^/]+\/premarket\/days$/.test(url.pathname),
    (req) => {
      const symbol = decodeURIComponent(new URL(req.url()).pathname.split("/")[3] ?? "");
      if (symbol === "005930") return { body: { symbol, days: ["20261120", "20261121", "20261122", "20261123"] } };
      if (symbol === "000660") return { body: { symbol, days: ["20261123"] } };
      return { body: { symbol, days: [] } };
    },
  );
  scenario.on(
    (url) => /^\/api\/symbols\/[^/]+\/premarket\/compare$/.test(url.pathname),
    (req) => {
      const url = new URL(req.url());
      const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const raw = url.searchParams.get("days") ?? "";
      const wanted = raw ? raw.split(",") : [];
      const table = symbol === "000660" ? HYNIX_SERIES : SAMSUNG_SERIES;
      const series = wanted.map((d) => table[d]).filter((s): s is PreMarketDaySeries => s !== undefined);
      return { body: { symbol, series } };
    },
  );
  scenario.on(
    (url) => url.pathname === "/api/premarket/snapshot",
    (req) => {
      const date = new URL(req.url()).searchParams.get("date") ?? "20261124";
      return { body: SNAPSHOTS[date] ?? SNAPSHOTS["20261124"] };
    },
  );
}

test("장전 동시호가 창을 열고 3일 비교, 포인터 툴팁, 과거 스냅샷 전환, 종목 연동 및 새로고침 복원을 확인한다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  setupPreMarketMocks(scenario);

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await addButton(page).click();
  await kindItem(page, "장전 동시호가").click();
  await expect(tabOf(page, "premarket")).toHaveAccessibleName(/^장전 동시호가/);

  const win = page.getByTestId("premarket-window");
  await expect(win).toBeVisible();
  await expect(win).toHaveAttribute("data-symbol", "005930");
  await expect(page.getByTestId("premarket-day-chip-20261121")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("premarket-day-chip-20261122")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("premarket-day-chip-20261123")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("premarket-day-chip-20261122").click();
  await page.getByTestId("premarket-day-chip-20261120").click();
  await expect(page.getByTestId("premarket-day-chip-20261120")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("premarket-day-chip-20261121")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("premarket-day-chip-20261123")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("premarket-outcome-20261120")).toContainText("허수 주의");

  const svg = page.getByTestId("premarket-overlay-chart");
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.78, box!.y + box!.height * 0.5);
  const tooltip = page.getByTestId("premarket-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("11/20");
  await expect(tooltip).toContainText("11/21");
  await expect(tooltip).toContainText("11/23");

  const dateSelect = page.getByTestId("premarket-snapshot-date");
  await dateSelect.selectOption("20261123");
  await expect(page.getByTestId("premarket-row-000660")).toBeVisible();
  await expect(page.getByTestId("premarket-row-000660")).toContainText("임의연장");
  await expect(page.getByTestId("premarket-row-000660")).toContainText("+6.00%");

  await page.getByTestId("premarket-row-000660").click();
  await expect(win).toHaveAttribute("data-symbol", "000660");
  await expect(cell(page)).toContainText("SK하이닉스");

  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.kind === "premarket")).toBe(true);
  await page.reload();
  await expect(tabOf(page, "premarket")).toHaveCount(1);
  await expect(page.getByTestId("premarket-window")).toBeVisible();
});

test("공개 모드에서는 장전 동시호가 창이 준비 중 상태를 보이고 사전 API를 호출하지 않는다", async ({ page, scenario }) => {
  scenario.publicMode.enable({ provider: "google", createdAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "premarket", link: "a", kind: "premarket" },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  await page.goto("/");
  await tabOf(page, "premarket").click();
  await expect(page.getByTestId("public-unavailable").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const premarketCalls = scenario.requests
    .map((r) => new URL(r.url()).pathname)
    .filter((p) => p.includes("/premarket"));
  expect(premarketCalls).toEqual([]);
});

test("기본 지수 레이아웃에서 장전 동시호가 창을 열어도 빈 종목 정보 요청을 보내지 않는다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await addButton(page).click();
  await kindItem(page, "장전 동시호가").click();
  const win = page.getByTestId("premarket-window");
  await expect(win).toBeVisible();
  await expect(win).toHaveAttribute("data-symbol", "");
  await expect(win).toContainText("종목 미선택");

  const invalidSymbolCalls = scenario.requests
    .map((r) => new URL(r.url()).pathname)
    .filter((p) => p === "/api/symbols/" || p === "/api/symbols");
  expect(invalidSymbolCalls).toEqual([]);
});

test("스냅샷 행을 클릭한 뒤에도 관심종목 클릭으로 다시 종목이 연동된다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  setupPreMarketMocks(scenario);
  const wl = scenario.documents.watchlists();
  const nextLists = wl.lists.map((list, idx) =>
    idx === 0 ? { ...list, symbols: ["005930", "000660"] } : list,
  );
  scenario.documents.saveWatchlists({ ...wl, lists: nextLists, revision: wl.revision + 1 });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await addButton(page).click();
  await kindItem(page, "장전 동시호가").click();
  const win = page.getByTestId("premarket-window");
  await expect(win).toHaveAttribute("data-symbol", "005930");

  await page.getByTestId("premarket-snapshot-date").selectOption("20261123");
  await page.getByTestId("premarket-row-000660").click();
  await expect(win).toHaveAttribute("data-symbol", "000660");

  const watchlist = page.getByRole("complementary", { name: "관심종목" });
  await watchlist.locator('li[data-code="005930"]').click();
  await expect(win).toHaveAttribute("data-symbol", "005930");
  await expect(cell(page)).toContainText("삼성전자");
});

test("스냅샷 날짜 조회가 실패해도 날짜 선택기가 활성화되어 다른 날짜로 복구할 수 있다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  setupPreMarketMocks(scenario);
  scenario.on(
    (url) => url.pathname === "/api/premarket/snapshot" && url.searchParams.get("date") === "20261123",
    () => ({
      status: 500,
      body: { error: { code: "internal", message: "스냅샷을 불러오지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } },
    }),
  );

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await addButton(page).click();
  await kindItem(page, "장전 동시호가").click();
  const dateSelect = page.getByTestId("premarket-snapshot-date");
  await expect(page.getByTestId("premarket-row-005930")).toBeVisible();

  await dateSelect.selectOption("20261123");
  await expect(page.getByTestId("premarket-snapshot-pane").getByRole("alert")).toContainText("스냅샷을 불러오지 못했습니다");
  await expect(dateSelect).toBeEnabled();

  await dateSelect.selectOption("20261124");
  await expect(page.getByTestId("premarket-row-005930")).toBeVisible();
});

test("실시간 flow 모드에서는 스냅샷과 비교를 주기적으로 갱신하고 마감 store 모드에서는 폴링을 멈춘다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "premarket", link: "a", kind: "premarket" },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  let flowSnapshotHits = 0;
  let flowCompareHits = 0;
  let storeSnapshotHits = 0;
  let storeCompareHits = 0;

  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/days$/.test(url.pathname),
    () => ({ body: { symbol: "005930", days: ["20261123", "20261124"] } }),
  );
  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/compare$/.test(url.pathname),
    (req) => {
      const days = (new URL(req.url()).searchParams.get("days") ?? "").split(",").filter(Boolean);
      const includesFlow = days.includes("20261124");
      if (includesFlow) {
        flowCompareHits++;
        const latePct = flowCompareHits >= 2 ? 4.5 : 2.0;
        const flowDay: PreMarketDaySeries = {
          date: "20261124",
          source: "flow",
          points: [
            { secOfDay: 30600, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 10000, expectedTurnoverMillionWon: 714 },
            { secOfDay: 32390, expectedPriceWon: flowCompareHits >= 2 ? 73150 : 71400, expectedReturnPct: latePct, expectedQty: 20000, expectedTurnoverMillionWon: 1463 },
          ],
          lateDropPct: flowCompareHits >= 2 ? 2.5 : 0.0,
          classification: "genuineGap",
          openPriceWon: null,
          return0900Pct: null,
          return0905Pct: null,
          return0910Pct: null,
        };
        const series = days.map((d) => (d === "20261124" ? flowDay : SAMSUNG_SERIES[d]!)).filter(Boolean);
        return { body: { symbol: "005930", series } };
      }
      storeCompareHits++;
      return { body: { symbol: "005930", series: [SAMSUNG_SERIES["20261123"]!] } };
    },
  );
  scenario.on(
    (url) => url.pathname === "/api/premarket/snapshot",
    (req) => {
      const date = new URL(req.url()).searchParams.get("date") ?? "20261124";
      if (date === "20261123") {
        storeSnapshotHits++;
        return { body: SNAPSHOTS["20261123"] };
      }
      flowSnapshotHits++;
      const pct = flowSnapshotHits >= 2 ? 4.5 : 2.0;
      return {
        body: {
          ...SNAPSHOTS["20261124"],
          rows: [{ ...SNAPSHOTS["20261124"]!.rows[0]!, expectedReturnPct: pct }],
        },
      };
    },
  );

  await page.clock.install({ time: scenario.now });
  await page.goto("/");
  await tabOf(page, "premarket").click();
  await expect(page.getByTestId("premarket-row-005930")).toContainText("+2.00%");
  await expect(page.getByTestId("premarket-outcome-20261124")).toContainText("0.00%");

  await page.clock.runFor(5_500);
  await expect(page.getByTestId("premarket-row-005930")).toContainText("+4.50%");
  await expect(page.getByTestId("premarket-outcome-20261124")).toContainText("+2.50%");
  expect(flowSnapshotHits).toBeGreaterThanOrEqual(2);
  expect(flowCompareHits).toBeGreaterThanOrEqual(2);

  await page.getByTestId("premarket-snapshot-date").selectOption("20261123");
  await expect(page.getByTestId("premarket-row-000660")).toBeVisible();
  await page.getByTestId("premarket-day-chip-20261124").click();
  await expect(page.getByTestId("premarket-outcome-20261124")).toHaveCount(0);

  const settledStoreSnap = storeSnapshotHits;
  const settledStoreCmp = storeCompareHits;
  await page.clock.runFor(15_000);
  expect(storeSnapshotHits).toBe(settledStoreSnap);
  expect(storeCompareHits).toBe(settledStoreCmp);
});

test("단일 포인트 날짜 시리즈는 호버 없이도 SVG 원 마커로 표시된다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "premarket", link: "a", kind: "premarket" },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/days$/.test(url.pathname),
    () => ({ body: { symbol: "005930", days: ["20261123"] } }),
  );
  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/compare$/.test(url.pathname),
    () => ({
      body: {
        symbol: "005930",
        series: [
          {
            date: "20261123",
            source: "store",
            points: [
              { secOfDay: 32000, expectedPriceWon: 72100, expectedReturnPct: 3.0, expectedQty: 15000, expectedTurnoverMillionWon: 1081.5 },
            ],
            lateDropPct: 0.0,
            classification: "genuineGap",
            openPriceWon: 72100,
            return0900Pct: 3.0,
            return0905Pct: 3.2,
            return0910Pct: 3.5,
          },
        ],
      },
    }),
  );

  await page.goto("/");
  await tabOf(page, "premarket").click();
  const marker = page.getByTestId("premarket-single-point-20261123");
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
});
