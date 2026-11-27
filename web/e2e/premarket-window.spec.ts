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
    const basePct = idx === 9 ? 1.3 : Number(((idx - 3) * 0.45).toFixed(2));
    const peakPct = idx === 9 ? 6.2 : Number((basePct + 0.8).toFixed(2));
    const midQty = idx === 9 ? 32000 : 28000 + idx * 4000;
    const endQty = idx === 9 ? 16000 : 42000 + idx * 5000;
    table[date] = {
      date,
      source: "store",
      points: [
        { secOfDay: 30600, expectedPriceWon: 70000 + idx * 200, expectedReturnPct: 0.4, expectedQty: 12000 + idx * 1000, expectedTurnoverMillionWon: 840 + idx * 80 },
        { secOfDay: 32000, expectedPriceWon: 72000 + idx * 300, expectedReturnPct: peakPct, expectedQty: midQty, expectedTurnoverMillionWon: Number(((midQty * 72000) / 1_000_000).toFixed(1)) },
        { secOfDay: 32390, expectedPriceWon: 71000 + idx * 250, expectedReturnPct: basePct, expectedQty: endQty, expectedTurnoverMillionWon: Number(((endQty * 71000) / 1_000_000).toFixed(1)) },
      ],
      lateDropPct: idx === 9 ? -4.9 : 0.2,
      classification: idx === 9 ? "spoofWarning" : idx === 7 ? "genuineGap" : "flat",
      openPriceWon: 71000 + idx * 250,
      return0900Pct: basePct,
      return0905Pct: basePct,
      return0910Pct: basePct,
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

test("장전 동시호가 창에서 2주 이중 Y축 차트, 좌측 세로 날짜 리스트, 스포트라이트·핀·기준일 전환 및 새로고침 복원을 확인한다", async ({ page, scenario }) => {
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
  await expect(page.getByTestId("premarket-snapshot-pane")).toHaveCount(0);
  await expect(page.getByTestId("premarket-outcomes")).toHaveCount(0);

  const dateList = page.getByTestId("premarket-date-list");
  await expect(dateList).toBeVisible();
  await expect(dateList).toContainText("이번주");
  await expect(dateList).toContainText("지난주");
  await expect(page.getByTestId("premarket-day-chip-20261127")).toHaveAttribute("data-role", "focus");
  await expect(page.getByTestId("premarket-day-chip-20261116")).toBeVisible();

  await expect(page.locator(".pm-bg-line")).toHaveCount(0);
  await expect(page.locator(".pm-band-area")).toBeVisible();
  await expect(page.locator(".pm-band-median")).toBeVisible();

  await page.getByTestId("premarket-day-chip-20261120").hover();
  await expect(page.locator('.pm-spot-line[data-date="20261120"]')).toBeVisible();
  await expect(page.locator('.pm-vol-spot-line[data-date="20261120"]')).toBeVisible();

  await page.getByTestId("premarket-day-chip-20261125").click();
  await expect(page.getByTestId("premarket-day-chip-20261125")).toHaveAttribute("data-role", "pin-0");
  await expect(page.locator('.pm-pin-line[data-date="20261125"]')).toBeVisible();
  await expect(page.locator('.pm-vol-pin-line[data-date="20261125"]')).toBeVisible();
  await page.getByTestId("premarket-day-chip-20261124").click();
  await expect(page.getByTestId("premarket-day-chip-20261124")).toHaveAttribute("data-role", "pin-1");
  await page.getByTestId("premarket-day-chip-20261120").click();
  await expect(page.getByTestId("premarket-day-chip-20261125")).toHaveAttribute("data-role", "bg");
  await expect(page.getByTestId("premarket-day-chip-20261124")).toHaveAttribute("data-role", "pin-0");
  await expect(page.getByTestId("premarket-day-chip-20261120")).toHaveAttribute("data-role", "pin-1");

  const svg = page.getByTestId("premarket-overlay-chart");
  await expect(page.getByTestId("premarket-vol-area")).toBeVisible();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.78, box!.y + box!.height * 0.5);
  const tooltip = page.getByTestId("premarket-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("11/27");
  await expect(tooltip).toContainText("11/24");
  await expect(tooltip).toContainText("11/20");
  await expect(tooltip).toContainText("직전 대비 물량 Δ");

  await page.getByTestId("premarket-focus-btn-20261125").click();
  await expect(page.getByTestId("premarket-day-chip-20261125")).toHaveAttribute("data-role", "focus");
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("11/25 예상가");

  await page.getByTestId("premarket-range-5").click();
  await expect(page.getByTestId("premarket-day-chip-20261116")).toHaveCount(0);
  await expect(page.getByTestId("premarket-day-chip-20261123")).toBeVisible();
  await page.getByTestId("premarket-range-10").click();
  await expect(page.getByTestId("premarket-day-chip-20261116")).toBeVisible();

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
    ...layout.windows.filter((w) => w.kind !== "chart"),
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

test("08:00 대기 상태에서 당일이 기준일로 표시되고 08:30 틱이 들어오면 실시간 곡선과 물량 면으로 자동 전환된다", async ({ page, scenario }) => {
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
    () => ({ body: { symbol: "005930", days: ["20261126", "20261127"] } }),
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
                { secOfDay: 30600, expectedPriceWon: 71400, expectedReturnPct: 2.0, expectedQty: 14000, expectedTurnoverMillionWon: 999.6 },
                { secOfDay: 30900, expectedPriceWon: 72450, expectedReturnPct: 3.5, expectedQty: 26000, expectedTurnoverMillionWon: 1883.7 },
              ],
              lateDropPct: 0,
              classification: "genuineGap",
              openPriceWon: null,
              return0900Pct: null,
              return0905Pct: null,
              return0910Pct: null,
            };
      return { body: { symbol: "005930", series: [SAMSUNG_SERIES["20261126"]!, todaySeries] } };
    },
  );

  await page.clock.install({ time: Date.parse("2026-11-27T08:15:00+09:00") });
  await page.goto("/");
  await tabOf(page, "premarket").click();

  const todayChip = page.getByTestId("premarket-day-chip-20261127");
  await expect(todayChip).toHaveAttribute("data-role", "focus");
  await expect(todayChip).toHaveAttribute("data-pending", "true");
  await expect(todayChip).toContainText("대기");
  await expect(page.getByTestId("premarket-pending-badge")).toBeVisible();
  await expect(page.getByTestId("premarket-waiting-pill")).toBeVisible();
  await expect(page.getByTestId("premarket-vol-area")).toHaveCount(0);
  await expect(page.locator('.pm-bg-line[data-date="20261126"]')).toBeVisible();

  await page.clock.runFor(5_500);
  await expect(page.getByTestId("premarket-waiting-pill")).toHaveCount(0);
  await expect(todayChip).toHaveAttribute("data-pending", "false");
  await expect(todayChip).toContainText("실시간");
  await expect(page.getByTestId("premarket-vol-area")).toBeVisible();
  await expect(page.locator('.pm-focus-line[data-date="20261127"]')).toBeVisible();
  await expect(page.getByTestId("premarket-head-metrics")).toContainText("+3.50%");
});
