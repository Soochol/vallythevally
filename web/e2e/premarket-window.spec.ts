import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { PreMarketDaySeries } from "../src/api/generated/PreMarketDaySeries";
import { cell, DEFAULT_LAYOUT_ID, expect, pollSaved, type Scenario, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const tabOf = (page: Page, id: string) => windowTabs(page).locator(`[role=tab][data-window-id="${id}"]`);

const TEN_DATES = [
  "20261116",
  "20261117",
  "20261118",
  "20261119",
  "20261120",
  "20261123",
  "20261124",
  "20261125",
  "20261126",
  "20261127",
] as const;

function buildSamsungSeries(): Readonly<Record<string, PreMarketDaySeries>> {
  const table: Record<string, PreMarketDaySeries> = {};
  TEN_DATES.forEach((date, idx) => {
    const isToday = idx === 9;
    const startPct = isToday ? 1.8 : Number(((idx - 4) * 0.25).toFixed(2));
    const midPct = isToday ? 4.6 : Number((startPct + 0.5).toFixed(2));
    const endPct = isToday ? 5.4 : Number((startPct + 0.7).toFixed(2));
    const startQty = isToday ? 28000 : 10000 + idx * 1000;
    const midQty = isToday ? 96000 : 24000 + idx * 3000;
    const endQty = isToday ? 168000 : 36000 + idx * 4000;
    const price = isToday ? 76200 : 71000 + idx * 200;
    table[date] = {
      date,
      source: "store",
      points: [
        { secOfDay: 31800, expectedPriceWon: price - 1500, expectedReturnPct: startPct, expectedQty: startQty, expectedTurnoverMillionWon: Number(((startQty * (price - 1500)) / 1_000_000).toFixed(1)) },
        { secOfDay: 32100, expectedPriceWon: price - 500, expectedReturnPct: midPct, expectedQty: midQty, expectedTurnoverMillionWon: Number(((midQty * (price - 500)) / 1_000_000).toFixed(1)) },
        { secOfDay: 32390, expectedPriceWon: price, expectedReturnPct: endPct, expectedQty: endQty, expectedTurnoverMillionWon: Number(((endQty * price) / 1_000_000).toFixed(1)) },
      ],
      lateDropPct: isToday ? 0.0 : 0.2,
      classification: isToday ? "genuineGap" : "flat",
      openPriceWon: price,
      return0900Pct: endPct,
      return0905Pct: endPct,
      return0910Pct: endPct,
    };
  });
  return table;
}

const SAMSUNG_SERIES = buildSamsungSeries();

const HYNIX_SERIES: Readonly<Record<string, PreMarketDaySeries>> = {
  "20261127": {
    date: "20261127",
    source: "store",
    points: [
      { secOfDay: 31800, expectedPriceWon: 204000, expectedReturnPct: 2.0, expectedQty: 15000, expectedTurnoverMillionWon: 3060 },
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

function setupPreMarketMocks(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart").map((w) => (w.kind === "watchlist" ? { ...w, link: "a" as const } : w)),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  scenario.on(
    (url) => /^\/api\/symbols\/[^/]+\/premarket\/days$/.test(url.pathname),
    (req) => {
      const symbol = decodeURIComponent(new URL(req.url()).pathname.split("/")[3] ?? "");
      if (symbol === "005930") return { body: { symbol, days: [...TEN_DATES] } };
      if (symbol === "000660") return { body: { symbol, days: ["20261127"] } };
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
}

test("장전 동시호가 창이 과거 2중 범위 밴드, 오늘 돌파 강조, 호버 툴바 제거, 기간·단위·도움말 전환 및 새로고침 복원을 보인다", async ({ page, scenario }) => {
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
  await expect(page.getByTestId("premarket-date-list")).toHaveCount(0);
  await expect(page.locator(".pm-chart-legend")).toHaveCount(0);
  await expect(page.locator(".pm-bg-line")).toHaveCount(0);

  await expect(page.getByTestId("premarket-head-metrics")).toContainText("+5.40%");
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("76,200원");
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("16.8만주");

  const svg = page.getByTestId("premarket-overlay-chart");
  await expect(svg).toContainText("08:50");
  await expect(svg).toContainText("09:00");
  await expect(page.getByTestId("premarket-price-band")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-band")).toBeVisible();
  await expect(page.getByTestId("premarket-price-series")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-series")).toBeVisible();
  await expect(page.getByTestId("premarket-price-breakout").first()).toBeVisible();
  await expect(page.getByTestId("premarket-vol-breakout").first()).toBeVisible();

  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.72, box!.y + box!.height * 0.38);
  await expect(page.getByTestId("premarket-tooltip")).toHaveCount(0);

  await page.getByTestId("premarket-help-btn").click();
  const help = page.getByTestId("premarket-help-popover");
  await expect(help).toBeVisible();
  await expect(help).toContainText("과거 9일 범위 대비 오늘");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);

  await page.getByTestId("premarket-range-5").click();
  await expect(page.getByTestId("premarket-range-5")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("premarket-help-btn").click();
  await expect(page.getByTestId("premarket-help-popover")).toContainText("과거 4일 범위 대비 오늘");
  await page.keyboard.press("Escape");

  await page.getByTestId("premarket-range-10").click();
  await expect(page.getByTestId("premarket-range-10")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("premarket-unit-turnover").click();
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("억");

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

test("관심종목 클릭으로 장전 동시호가 창의 종목이 연동된다", async ({ page, scenario }) => {
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

  const watchlist = page.getByRole("complementary", { name: "관심종목" });
  await watchlist.locator('li[data-code="000660"]').click();
  await expect(win).toHaveAttribute("data-symbol", "000660");
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("208,000원");

  await watchlist.locator('li[data-code="005930"]').click();
  await expect(win).toHaveAttribute("data-symbol", "005930");
  await expect(cell(page)).toContainText("삼성전자");
});

test("실시간 flow 모드에서는 비교 자료를 주기적으로 갱신하고 마감 store 모드에서는 폴링을 멈춘다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "premarket", link: "a", kind: "premarket" },
    ...layout.windows.filter((w) => w.kind !== "chart").map((w) => (w.kind === "watchlist" ? { ...w, link: "a" as const } : w)),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  const wl = scenario.documents.watchlists();
  const nextLists = wl.lists.map((list, idx) =>
    idx === 0 ? { ...list, symbols: ["005930", "000660"] } : list,
  );
  scenario.documents.saveWatchlists({ ...wl, lists: nextLists, revision: wl.revision + 1 });

  let flowCompareHits = 0;
  let storeCompareHits = 0;

  scenario.on(
    (url) => /^\/api\/symbols\/[^/]+\/premarket\/days$/.test(url.pathname),
    (req) => {
      const symbol = decodeURIComponent(new URL(req.url()).pathname.split("/")[3] ?? "");
      if (symbol === "000660") return { body: { symbol, days: ["20261127"] } };
      return { body: { symbol, days: ["20261126", "20261127"] } };
    },
  );
  scenario.on(
    (url) => /^\/api\/symbols\/[^/]+\/premarket\/compare$/.test(url.pathname),
    (req) => {
      const symbol = decodeURIComponent(new URL(req.url()).pathname.split("/")[3] ?? "");
      if (symbol === "000660") {
        storeCompareHits++;
        return { body: { symbol, series: [HYNIX_SERIES["20261127"]!] } };
      }
      flowCompareHits++;
      const latePct = flowCompareHits >= 2 ? 4.5 : 2.0;
      const flowDay: PreMarketDaySeries = {
        date: "20261127",
        source: "flow",
        points: [
          { secOfDay: 31800, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 10000, expectedTurnoverMillionWon: 714 },
          { secOfDay: 32390, expectedPriceWon: flowCompareHits >= 2 ? 73150 : 71400, expectedReturnPct: latePct, expectedQty: 20000, expectedTurnoverMillionWon: 1463 },
        ],
        lateDropPct: flowCompareHits >= 2 ? 2.5 : 0.0,
        classification: "genuineGap",
        openPriceWon: null,
        return0900Pct: null,
        return0905Pct: null,
        return0910Pct: null,
      };
      return { body: { symbol, series: [SAMSUNG_SERIES["20261126"]!, flowDay] } };
    },
  );

  await page.clock.install({ time: scenario.now });
  await page.goto("/");
  await tabOf(page, "premarket").click();
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("+2.00%");

  await page.clock.runFor(5_500);
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("+4.50%");
  expect(flowCompareHits).toBeGreaterThanOrEqual(2);

  const watchlist = page.getByRole("complementary", { name: "관심종목" });
  await watchlist.locator('li[data-code="000660"]').click();
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("208,000원");

  const settledStoreCmp = storeCompareHits;
  await page.clock.runFor(15_000);
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
    () => ({ body: { symbol: "005930", days: ["20261127"] } }),
  );
  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/compare$/.test(url.pathname),
    () => ({
      body: {
        symbol: "005930",
        series: [
          {
            date: "20261127",
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
  const marker = page.getByTestId("premarket-single-point-20261127");
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
});

test("08:00 대기 상태에서 과거 범위 밴드가 보이고 틱이 들어오면 오늘 선과 물량으로 자동 전환된다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "premarket", link: "a", kind: "premarket" },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  let compareHits = 0;

  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/days$/.test(url.pathname),
    () => ({ body: { symbol: "005930", days: ["20261125", "20261126", "20261127"] } }),
  );
  scenario.on(
    (url) => /^\/api\/symbols\/005930\/premarket\/compare$/.test(url.pathname),
    () => {
      compareHits++;
      const todaySeries: PreMarketDaySeries =
        compareHits === 1
          ? {
              date: "20261127",
              source: "flow",
              points: [],
              lateDropPct: 0,
              classification: "flat",
              openPriceWon: null,
              return0900Pct: null,
              return0905Pct: null,
              return0910Pct: null,
            }
          : {
              date: "20261127",
              source: "flow",
              points: [
                { secOfDay: 31800, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 44000, expectedTurnoverMillionWon: 3141.6 },
                { secOfDay: 32040, expectedPriceWon: 72450, expectedReturnPct: 3.5, expectedQty: 98000, expectedTurnoverMillionWon: 7100.1 },
              ],
              lateDropPct: 0,
              classification: "genuineGap",
              openPriceWon: null,
              return0900Pct: null,
              return0905Pct: null,
              return0910Pct: null,
            };
      return { body: { symbol: "005930", series: [SAMSUNG_SERIES["20261125"]!, SAMSUNG_SERIES["20261126"]!, todaySeries] } };
    },
  );

  await page.clock.install({ time: Date.parse("2026-11-27T08:15:00+09:00") });
  await page.goto("/");
  await tabOf(page, "premarket").click();

  await expect(page.getByTestId("premarket-pending-badge")).toBeVisible();
  await expect(page.getByTestId("premarket-waiting-hint")).toContainText("과거 2일 범위");
  await expect(page.getByTestId("premarket-price-band")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-band")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-series")).toHaveCount(0);

  await page.clock.runFor(5_500);
  await expect(page.getByTestId("premarket-pending-badge")).toHaveCount(0);
  await expect(page.getByTestId("premarket-waiting-hint")).toHaveCount(0);
  await expect(page.getByTestId("premarket-live-badge")).toBeVisible();
  await expect(page.getByTestId("premarket-price-series")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-series")).toBeVisible();
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("+3.50%");
});
