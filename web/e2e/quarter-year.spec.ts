import type { Locator, Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Layout } from "../src/api/generated/Layout";
import type { Period } from "../src/api/generated/Period";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, dragTowardPast, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const PERIODS = [{ period: "Q", label: "분기" }, { period: "Y", label: "연" }] as const;
const FAILURE = { error: { code: "kiwoom_unavailable", message: "입력값 오류[1501:입력값을 확인하세요]", reason: null, retryAt: null, manualActionRequired: false } };
const kst = (date: string) => Date.parse(`${date}T00:00:00+09:00`) / 1000;

function reply(period: "Q" | "Y", index = false, count = period === "Q" ? 38 : 12, offset = 0, more = false): BarsPage {
  const bars = Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, period === "Q" ? 9 - 3 * (offset + i) : 0, 1));
    if (period === "Y") date.setUTCFullYear(2026 - offset - i);
    const price = 100_000 + (count - i) * 100;
    return { t: kst(date.toISOString().slice(0, 10)), o: price - 100, h: price + 200, l: price - 200, c: price, v: 100 + i };
  }).reverse();
  const current = offset === 0 ? bars.pop() ?? null : null;
  return { symbol: index ? "IDX:001" : "005930", venue: index ? null : "combined", period, bars, current, seq: null, nextBefore: more ? bars[0]?.t ?? null : null };
}

function seedBars(scenario: Scenario, period: "Q" | "Y", index = false): void {
  scenario.reply(url => url.pathname === "/api/bars" && url.searchParams.get("symbol") === (index ? "IDX:001" : "005930") && url.searchParams.get("period") === period, { body: reply(period, index) });
}

async function ready(page: Page, label: string) {
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${label}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
}

async function choose(group: Locator, label: string) {
  const button = group.getByRole("button", { name: label, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function seed(scenario: Scenario, period: Period) {
  const layout: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const { id, name, arrangement, sync, revision } = layout;
  const chartSettings = {
    v: 2, style: "candle", scale: "normal", visibleBars: null, showExtremes: false, showOhlc: true, showOhlcChange: false, extremeBasis: "last", compare: ["IDX:001"],
    indicators: [
      { id: "ma5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 2 } },
      { id: "volume", spec: { kind: "volume", maPeriod: 5 }, panel: "volume-panel", visible: true, style: { colors: ["ind-1"], width: 1 } },
      { id: "hidden-rsi", spec: { kind: "rsi", period: 5, signal: null }, panel: "rsi-panel", visible: false, style: { colors: ["ind-3"], width: 1 } },
    ], panels: [{ id: "volume-panel", stretch: 0.35 }, { id: "rsi-panel", stretch: 0.2 }],
  };
  scenario.documents.saveLayout({ id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol: "005930", venue: "combined", period, symbolLink: false, chartSettings }] });

  return chartSettings;
}

for (const phone of [false, true]) {
  test.describe(phone ? "휴대폰 Q/Y" : "데스크톱 Q/Y", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    for (const index of [false, true]) {
      test(`${index ? "업종지수" : "주식"}의 Q/Y 선택과 현재 봉`, async ({ page, scenario }) => {
        for (const { period } of PERIODS) seedBars(scenario, period, index);
        const symbol = index ? "IDX:001" : "005930";
        const name = index ? "코스피" : "삼성전자 통합";
        await page.goto(`/?symbol=${symbol}`);
        await ready(page, `${name} 일`);
        const group = phone ? page.getByRole("navigation", { name: "봉 주기" }) : page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
        for (const { period, label } of PERIODS) {
          const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/bars" && new URL(r.url()).searchParams.get("period") === period && r.ok());
          await choose(group, label);
          const data: BarsPage = await (await loaded).json();
          expect(data.symbol).toBe(symbol);
          expect(data.venue).toBe(index ? null : "combined");
          expect(data.current?.t).toBe(kst(period === "Q" ? "2026-10-01" : "2026-01-01"));
          await ready(page, `${name} ${label}`);
          const chart = chartOf(cell(page));
          await expect(chart).toHaveAttribute("data-last-bar-t", String(data.current!.t));
          await expect(chart).toHaveAttribute("data-last-close", String(data.current!.c));
          await expect.poll(() => scenario.live.subscriptions().map(value => value.symbol)).toContain(symbol);
          const price = index ? "6001.23" : "210123";
          await expect(async () => {
            expect(await scenario.live.update(index ? "IDX:001" : "005930", { c: Math.abs(Number(`+${price}`)), v: Math.abs(Number("1000")) })).toBeGreaterThan(0);
            await expect(chart).toHaveAttribute("data-last-close", price, { timeout: 1500 });
          }).toPass({ timeout: 15000 });
          await expect(chart).toHaveAttribute("data-last-bar-t", String(data.current!.t));
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
        await expect.poll(async () => {
          const stored: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
          return stored.cells[0]!.period;
        }).toBe("Y");
        await page.reload();
        await ready(page, `${name} 연`);
        await expect(group.getByRole("button", { name: "연", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(group.getByRole("button", { name: "연", exact: true })).toBeInViewport();
      });
    }
  });
}

for (const { period, label } of PERIODS) {
  test(`${label}봉 5봉 이동평균·비교·드로잉·패널 설정을 저장하고 새로고침 뒤 복원한다`, async ({ page, scenario }) => {
    seedBars(scenario, period);
    seedBars(scenario, period, true);
    const settings = await seed(scenario, period);
    const drawing: DrawingInput = { id: "01900000-0000-7000-8000-000000000158", symbol: "005930", tool: "trendline", points: [{ t: kst("2025-01-01"), price: 100_000 }, { t: kst("2026-01-01"), price: 101_000 }], text: null, style: {}, locked: false, hidden: false, periods: [period], z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
    scenario.documents.saveDrawing(drawing);
    await page.addInitScript(installFrameProbe);
    await page.goto("/");
    const verify = async () => {
      await ready(page, `삼성전자 통합 ${label}`);
      const compare = cell(page).locator('[data-compare-row="IDX:001"]');
      await expect(compare).not.toHaveAttribute("data-last-t", "");
      await expect(compare).not.toContainText("받지 못함");
      await expect(compare).toHaveAttribute("data-last-t", String(kst(period === "Q" ? "2026-10-01" : "2026-01-01")));
      await expect.poll(() => page.evaluate(() => {
        const series = window.frameProbe.snapshot();
        const bars = series.find((s) => s.type === "Candlestick")?.data ?? [];
        const ma = series.find((s) => s.type === "Custom")?.data ?? [];
        const last = ma.at(-1);
        if (bars.length < 5 || !last || !("value" in last)) return false;
        const tail = bars.slice(-5);
        const average = tail.reduce((sum, b) => sum + ("close" in b ? b.close : 0), 0) / 5;
        return last.time === bars.at(-1)?.time && Math.abs(last.value - average) < 0.0001;
      })).toBe(true);
      const projected = async () => JSON.parse((await cell(page).locator(".drawing-mirror").getAttribute("data-drawings")) ?? "[]");
      await expect.poll(async () => (await projected()).length).toBe(1);
      const drawn = await projected();
      expect(drawn[0].points.every((p: { x: number; y: number } | null) => p !== null && Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      await expect(page.locator('[data-indicator-row="volume"]')).toContainText("거래량");
      await expect(page.locator('[data-indicator-row="hidden-rsi"] button[title="보이기"]')).toHaveCount(1);
    };
    await verify();
    const group = page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
    await choose(group, "월");
    await ready(page, "삼성전자 통합 월");
    await expect.poll(async () => JSON.parse((await cell(page).locator(".drawing-mirror").getAttribute("data-drawings")) ?? "[]").length).toBe(0);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/layouts/") && r.request().postDataJSON().cells[0].period === period && r.ok());
    await choose(group, label);
    await verify();
    await saved;

    await page.reload();
    await verify();
    const stored: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
    expect(stored.cells[0]!.period).toBe(period);
    expect(stored.cells[0]!.chartSettings).toEqual(settings);
    const drawings: Drawing[] = scenario.documents.drawings("005930");
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject(drawing);
  });

  test(`${label}봉 최초 조회 실패는 빈 차트와 재시도를 보이며 다른 종목은 사용할 수 있다`, async ({ page, scenario }) => {
    const match = (url: URL) => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("period") === period;
    const first = scenario.hold(match);
    await page.goto(`/?symbol=005930&period=${period}`);
    await first.received;
    await expect(cell(page)).toHaveAttribute("aria-busy", "true");
    first.reply({ status: 503, body: FAILURE });
    const alert = cell(page).getByRole("alert");
    await expect(alert).toContainText("1501");
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "0");
    seedBars(scenario, period, true);
    await page.goto(`/?symbol=IDX:001&period=${period}`);
    await ready(page, `코스피 ${label}`);
    scenario.reply(match, { status: 503, body: FAILURE });
    await page.goto(`/?symbol=005930&period=${period}`);
    await expect(alert).toBeVisible();
    const retry = scenario.hold(match);
    await alert.getByRole("button", { name: "다시 시도" }).click();
    await retry.received;
    await expect(cell(page)).toHaveAttribute("aria-busy", "true");
    retry.reply({ body: reply(period) });
    await ready(page, `삼성전자 통합 ${label}`);
    await expect(alert).toBeHidden();
  });

  test(`${label}봉 과거 조회 도중 실패는 받은 봉을 유지하고 로딩·재시도로 이어 받는다`, async ({ page, scenario }) => {
    const initial = reply(period, false, 501, 0, true);
    scenario.reply(url => url.pathname === "/api/bars" && !url.searchParams.has("before"), { body: initial });
    const pastMatch = (url: URL) => url.pathname === "/api/bars" && url.searchParams.has("before");
    const past = scenario.hold(pastMatch);
    await page.goto(`/?symbol=005930&period=${period}`);
    await ready(page, `삼성전자 통합 ${label}`);
    const chart = chartOf(cell(page));
    await expect(chart).toHaveAttribute("data-bar-count", "501");
    const before = await chart.getAttribute("data-first-bar-t");
    await dragTowardPast(page, chart, () => expect(cell(page).getByRole("status")).toContainText("과거 봉을 불러오는 중입니다", { timeout: 500 }));
    past.reply({ status: 503, body: FAILURE });
    const alert = cell(page).getByRole("alert");
    await expect(alert).toContainText("과거 봉을 받지 못했습니다");
    await expect(chart).toHaveAttribute("data-bar-count", "501");
    await expect(chart).toHaveAttribute("data-first-bar-t", before!);
    const retry = scenario.hold(pastMatch);
    await alert.getByRole("button", { name: "다시 시도" }).click();
    await retry.received;
    await expect(cell(page).getByRole("status")).toContainText("과거 봉을 불러오는 중입니다");
    retry.reply({ body: reply(period, false, 2, 501) });
    await expect.poll(async () => Number(await chart.getAttribute("data-bar-count"))).toBeGreaterThan(501);
    await expect(alert).toBeHidden();
    await expect(cell(page).getByRole("status")).toBeHidden();
  });
}

test("월·분기·연 주기를 앞뒤로 이동하고 연봉에서 다음 이동이 멈춘다", async ({ page, scenario }) => {
  for (const { period } of PERIODS) seedBars(scenario, period);
  await page.goto("/?symbol=005930&period=M");
  await ready(page, "삼성전자 통합 월");
  for (const label of ["분기", "연", "연"]) {
    await page.keyboard.press("]");
    await ready(page, `삼성전자 통합 ${label}`);
  }
  for (const label of ["분기", "월", "주", "일", "60분"]) {
    await page.keyboard.press("[");
    await ready(page, `삼성전자 통합 ${label}`);
  }
});
