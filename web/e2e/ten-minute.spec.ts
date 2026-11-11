import type { Locator, Page } from "@playwright/test";
import type { SeriesKey } from "../src/api/bars";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Layout } from "../src/api/generated/Layout";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const TEN_MINUTES = 600;

function recordBarRequests(page: Page): SeriesKey[] {
  const seen: SeriesKey[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname !== "/api/bars") return;
    const q = url.searchParams;
    seen.push({ symbol: q.get("symbol")!, venue: q.get("venue") as SeriesKey["venue"], period: q.get("period") as SeriesKey["period"] });
  });
  return seen;
}

async function expectTenMinuteBars(page: Page, requested: SeriesKey[], label: string, series: SeriesKey) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label}`);
  await expect.poll(() => requested.at(-1), { message: `${label}의 마지막 봉 요청` }).toEqual(series);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(chart).not.toHaveAttribute("data-bar-count", "0");
  expect(Number(await chart.getAttribute("data-last-bar-t")) % TEN_MINUTES).toBe(0);
}

async function choose(group: Locator, name: string) {
  const button = group.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

function toolbarLayout(page: Page) {
  return page.getByRole("toolbar", { name: "차트 도구 막대" }).evaluate((bar) => {
    const wrapped: string[] = [];
    const walker = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(text);
      if (text.textContent?.trim() && range.getClientRects().length > 1) wrapped.push(text.textContent.trim());
    }
    return { wrapped, pageOverflow: document.documentElement.scrollWidth - window.innerWidth, toolbarOverflow: bar.scrollWidth - bar.clientWidth };
  });
}

const layoutSaved = (page: Page, want: { venue: string; period: string }) =>
  page.waitForResponse((r) => {
    if (r.request().method() !== "PUT" || !r.url().includes("/api/layouts/") || !r.ok()) return false;
    const saved = (r.request().postDataJSON() as Layout).cells[0]!;
    return saved.venue === want.venue && saved.period === want.period;
  });

test.describe("데스크톱", () => {
  test("봉 주기 막대의 5분과 15분 사이에서 10분을 골라 거래소마다 10분봉을 그리고, [ ]로 이웃 봉 주기로 옮긴다", async ({ page }) => {
    const requested = recordBarRequests(page);
    await page.goto("/?symbol=005930");
    const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
    const periods = toolbar.getByRole("group", { name: "봉 주기" });
    const venues = toolbar.getByRole("group", { name: "거래소" });
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await expect(periods.getByRole("button")).toHaveText(["1분", "3분", "5분", "10분", "15분", "30분", "60분", "일", "주", "월"]);

    await choose(periods, "10분");
    await expectTenMinuteBars(page, requested, "삼성전자 통합 10분", { symbol: "005930", venue: "combined", period: "10m" });
    await choose(venues, "KRX");
    await expectTenMinuteBars(page, requested, "삼성전자 KRX 10분", { symbol: "005930", venue: "krx", period: "10m" });
    await choose(venues, "NXT");
    await expectTenMinuteBars(page, requested, "삼성전자 NXT 10분", { symbol: "005930", venue: "nxt", period: "10m" });

    await page.keyboard.press("BracketLeft");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 NXT 5분");
    await page.keyboard.press("BracketRight");
    await expectTenMinuteBars(page, requested, "삼성전자 NXT 10분", { symbol: "005930", venue: "nxt", period: "10m" });
    await page.keyboard.press("BracketRight");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 NXT 15분");
    await expect(periods.getByRole("button", { name: "15분", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  for (const width of [1024, 1440]) {
    test(`${width}px 창에서 10분을 골라도 막대 글자가 한 줄이고 페이지가 가로로 넘치지 않으며, 거래소와 다른 도구를 쓴다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const requested = recordBarRequests(page);
      await page.goto("/?symbol=005930");
      const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
      await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");

      await choose(toolbar.getByRole("group", { name: "봉 주기" }), "10분");
      await expectTenMinuteBars(page, requested, "삼성전자 통합 10분", { symbol: "005930", venue: "combined", period: "10m" });
      expect(await toolbarLayout(page)).toEqual({ wrapped: [], pageOverflow: 0, toolbarOverflow: 0 });

      await choose(toolbar.getByRole("group", { name: "거래소" }), "KRX");
      await expectTenMinuteBars(page, requested, "삼성전자 KRX 10분", { symbol: "005930", venue: "krx", period: "10m" });
      await toolbar.getByRole("button", { name: "봉 모양" }).click();
      await expect(page.getByRole("menu", { name: "봉 모양" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(toolbar.getByRole("button", { name: "테마 바꾸기" })).toBeInViewport();
      expect(await toolbarLayout(page)).toEqual({ wrapped: [], pageOverflow: 0, toolbarOverflow: 0 });
    });
  }

  test("지수도 10분봉으로 그린다", async ({ page }) => {
    const requested = recordBarRequests(page);
    await page.goto("/?symbol=IDX:001&period=10m");
    await expectTenMinuteBars(page, requested, "코스피 10분", { symbol: "IDX:001", venue: null, period: "10m" });
    const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
    await expect(periods.getByRole("button", { name: "10분", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("10분봉을 고른 레이아웃은 새로고침과 서버 재시작 뒤에도 10분봉을 다시 받는다", async ({ app, page }) => {
    const requested = recordBarRequests(page);
    await page.goto("/?symbol=005930");
    const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    const saved = layoutSaved(page, { venue: "combined", period: "10m" });
    await choose(periods, "10분");
    await saved;
    await expect(page.getByRole("contentinfo").getByText(/자동 저장됨/)).toBeVisible();

    const expectRestored = async () => {
      await expectTenMinuteBars(page, requested, "삼성전자 통합 10분", { symbol: "005930", venue: "combined", period: "10m" });
      await expect(periods.getByRole("button", { name: "10분", exact: true })).toHaveAttribute("aria-pressed", "true");
    };
    requested.length = 0;
    await page.reload();
    await expectRestored();

    await app.restart();
    requested.length = 0;
    await page.reload();
    await expectRestored();
    const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    expect(layout.cells[0]!.period).toBe("10m");
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("봉 주기 칩의 5분과 15분 사이에서 10분을 고르고, 다시 열어도 10분 칩이 눌려 있다", async ({ page }) => {
    const requested = recordBarRequests(page);
    await page.goto("/?symbol=005930");
    const chips = page.getByRole("navigation", { name: "봉 주기" });
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await expect(chips.getByRole("button")).toHaveText(["5분", "10분", "15분", "60분", "일", "주", "월"]);

    await choose(chips, "10분");
    await expectTenMinuteBars(page, requested, "삼성전자 통합 10분", { symbol: "005930", venue: "combined", period: "10m" });
    const saved = layoutSaved(page, { venue: "krx", period: "10m" });
    await choose(page.getByRole("group", { name: "거래소" }), "KRX");
    await expectTenMinuteBars(page, requested, "삼성전자 KRX 10분", { symbol: "005930", venue: "krx", period: "10m" });
    await saved;

    await page.reload();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 KRX 10분");
    await expect(chips.getByRole("button", { name: "10분", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("실시간", () => {
  const MONDAY_ONE_MINUTE_BEFORE_10_10_KST = "20261109100900";
  test.use({ clockStart: MONDAY_ONE_MINUTE_BEFORE_10_10_KST });

  const AT_1000 = Date.parse("2026-11-09T10:00:00+09:00") / 1000;
  const trade = (hhmmss: string, price: number, qty: number) => ({
    "20": hhmmss, "10": `+${price}`, "15": `+${qty}`, "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2",
  });
  const lastBar = async (chart: Locator) => {
    const [t, close, count] = await Promise.all(["data-last-bar-t", "data-last-close", "data-bar-count"].map((a) => chart.getAttribute(a)));
    return { t: Number(t), close: Number(close), count: Number(count) };
  };

  test("같은 10분 구간의 체결은 현재 봉을 바꾸고, 다음 10분 첫 체결에서 새 봉이 붙는다", async ({ page, app }) => {
    await page.goto("/?symbol=005930&period=10m");
    const chart = chartOf(cell(page));
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 10분");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toContain("005930_AL");
    const before = await lastBar(chart);

    await expect(async () => {
      await app.fake.pushReal("0B", "005930_AL", trade("100901", 201_000, 10));
      expect(await lastBar(chart)).toEqual({ t: AT_1000, close: 201_000, count: before.count + 1 });
    }).toPass({ timeout: 15_000 });
    await app.fake.pushReal("0B", "005930_AL", trade("100959", 201_500, 5));
    await expect.poll(() => lastBar(chart)).toEqual({ t: AT_1000, close: 201_500, count: before.count + 1 });
    await app.fake.pushReal("0B", "005930_AL", trade("101000", 200_500, 3));
    await expect.poll(() => lastBar(chart)).toEqual({ t: AT_1000 + TEN_MINUTES, close: 200_500, count: before.count + 2 });
  });
});

test.describe("분석 도구", () => {
  async function seedLayout(app: App, chartSettings: object) {
    const { id, name, arrangement, sync, revision }: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    const body = { id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol: "005930", venue: "combined", period: "10m", symbolLink: false, chartSettings }] };
    const r = await fetch(`${app.url}/api/layouts/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(r.ok).toBe(true);
  }

  test("10분봉 칸의 지표를 계산하고 비교 종목도 10분봉으로 받는다", async ({ page, app }) => {
    const ma = { id: "m", spec: { kind: "ma", method: "sma", period: 3 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } };
    await seedLayout(app, { v: 2, style: "candle", scale: "normal", indicators: [ma], compare: ["IDX:001"], panels: [] });
    const requested = recordBarRequests(page);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 10분");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => requested).toEqual(expect.arrayContaining([
      { symbol: "005930", venue: "combined", period: "10m" },
      { symbol: "IDX:001", venue: null, period: "10m" },
    ]));
    expect(Number(await chartOf(cell(page)).getAttribute("data-last-bar-t")) % TEN_MINUTES).toBe(0);
    await expect(page.locator('[data-indicator-row="m"]')).toContainText(/\d/);
    await expect(page.locator('[data-indicator-row="m"]')).not.toContainText("오류");
    const compareRow = cell(page).locator('[data-compare-row="IDX:001"]');
    await expect(compareRow).not.toHaveAttribute("data-last-t", "");
    expect(Number(await compareRow.getAttribute("data-last-t")) % TEN_MINUTES).toBe(0);
  });

  test("드로잉의 보이는 봉 주기에 10분이 들어간다", async ({ page, app }) => {
    const hline = { id: "01900000-0000-7000-8000-000000000150", symbol: "IDX:001", tool: "hline", points: [{ t: 1_794_000_000, price: 5_050 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
    const seeded = await fetch(`${app.url}/api/drawings/${hline.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(hline) });
    expect(seeded.status).toBe(200);
    const savedPeriods = async () => ((await (await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`)).json()) as Drawing[])[0]!.periods;
    const shown = async () => JSON.parse((await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings")) ?? "[]").length as number;

    await page.goto("/?symbol=IDX:001&period=10m");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 10분");
    await expect.poll(shown).toBe(1);
    const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
    const pick = async (item: string) => {
      await page.getByRole("region", { name: "개체 목록" }).getByRole("button", { name: "고르기: 수평선" }).click();
      await page.getByRole("button", { name: "드로잉 더 보기" }).click();
      await page.getByRole("menuitem", { name: item, exact: true }).click();
    };

    await page.getByRole("button", { name: "개체 목록 열기" }).click();
    await pick("분봉만");
    await expect.poll(savedPeriods).toEqual(["1m", "3m", "5m", "10m", "15m", "30m", "60m"]);
    await choose(periods, "일");
    await expect.poll(shown).toBe(0);
    await choose(periods, "10분");
    await expect.poll(shown).toBe(1);

    await pick("지금 봉 주기만");
    await expect.poll(savedPeriods).toEqual(["10m"]);
    await choose(periods, "5분");
    await expect.poll(shown).toBe(0);
    await choose(periods, "10분");
    await expect.poll(shown).toBe(1);
  });
});
