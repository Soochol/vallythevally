import type { Locator, Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { Drawing } from "../src/api/generated/Drawing";
import type { Layout } from "../src/api/generated/Layout";
import type { Period } from "../src/api/generated/Period";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, dragTowardPast, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const PERIODS = [{ period: "Q", label: "분기" }, { period: "Y", label: "연" }] as const;
const FAILURE = { return_code: 2, return_msg: "입력값 오류[1501:입력값을 확인하세요]" };
const kst = (date: string) => Date.parse(`${date}T00:00:00+09:00`) / 1000;

function reply(period: "Q" | "Y", index = false, count = period === "Q" ? 38 : 12, offset = 0, more = false) {
  const rows = Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(2026, period === "Q" ? 10 - offset - i : 0, 1));
    if (period === "Y") date.setUTCFullYear(2026 - offset - i);
    const price = 100_000 + (count - i) * 100;
    return { dt: date.toISOString().slice(0, 10).replaceAll("-", ""), open_pric: String(price - 100), high_pric: String(price + 200), low_pric: String(price - 200), cur_prc: String(price), trde_qty: String(100 + i) };
  });
  const field = index ? (period === "Q" ? "inds_mth_pole_qry" : "inds_yr_pole_qry") : (period === "Q" ? "stk_mth_pole_chart_qry" : "stk_yr_pole_chart_qry");
  return {
    apiId: index ? (period === "Q" ? "ka20008" : "ka20019") : (period === "Q" ? "ka10083" : "ka10094"),
    status: 200,
    body: { return_code: 0, return_msg: "synthetic", ...(index ? { inds_cd: "001" } : { stk_cd: "005930_AL" }), [field]: rows, _headers: { "cont-yn": more ? "Y" : "N", "next-key": more ? "OLDER" : "" } },
  };
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

async function seed(app: App, period: Period) {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const { id, name, arrangement, sync, revision } = layout;
  const chartSettings = {
    v: 2, style: "candle", scale: "normal", compare: ["IDX:001"],
    indicators: [
      { id: "ma5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 2 } },
      { id: "volume", spec: { kind: "volume", maPeriod: 5 }, panel: "volume-panel", visible: true, style: { colors: ["ind-1"], width: 1 } },
      { id: "hidden-rsi", spec: { kind: "rsi", period: 5, signal: null }, panel: "rsi-panel", visible: false, style: { colors: ["ind-3"], width: 1 } },
    ], panels: [{ id: "volume-panel", stretch: 0.35 }, { id: "rsi-panel", stretch: 0.2 }],
  };
  const res = await fetch(`${app.url}/api/layouts/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol: "005930", venue: "combined", period, symbolLink: false, chartSettings }] }) });
  expect(res.ok).toBe(true);
  return chartSettings;
}

for (const phone of [false, true]) {
  test.describe(phone ? "휴대폰 Q/Y" : "데스크톱 Q/Y", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    for (const index of [false, true]) {
      test(`${index ? "업종지수" : "주식"}의 Q/Y 선택과 현재 봉`, async ({ page, app }) => {
        for (const { period } of PERIODS) await app.fake.respondWith(reply(period, index));
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
          await expect.poll(async () => (await app.fake.registered())[index ? "0J" : "0B"] ?? []).toContain(index ? "001" : "005930_AL");
          const price = index ? "6001.23" : "210123";
          await expect(async () => {
            expect(await app.fake.pushReal(index ? "0J" : "0B", index ? "001" : "005930_AL", { "20": "100031", "10": `+${price}`, "15": "+3", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" })).toBeGreaterThan(0);
            await expect(chart).toHaveAttribute("data-last-close", price, { timeout: 1500 });
          }).toPass({ timeout: 15000 });
          await expect(chart).toHaveAttribute("data-last-bar-t", String(data.current!.t));
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
        await expect.poll(async () => {
          const stored: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
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
  test(`${label}봉 5봉 이동평균·비교·드로잉·패널 설정을 저장하고 재시작 뒤 복원한다`, async ({ page, app }) => {
    await app.fake.respondWith(reply(period));
    await app.fake.respondWith(reply(period, true));
    const settings = await seed(app, period);
    const drawing: DrawingInput = { id: "01900000-0000-7000-8000-000000000158", symbol: "005930", tool: "trendline", points: [{ t: kst("2025-01-01"), price: 100_000 }, { t: kst("2026-01-01"), price: 101_000 }], text: null, style: {}, locked: false, hidden: false, periods: [period], z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
    expect((await fetch(`${app.url}/api/drawings/${drawing.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(drawing) })).ok).toBe(true);
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
    await app.restart();
    await page.reload();
    await verify();
    const stored: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    expect(stored.cells[0]!.period).toBe(period);
    expect(stored.cells[0]!.chartSettings).toEqual(settings);
    const drawings: Drawing[] = await (await fetch(`${app.url}/api/drawings?symbol=005930`)).json();
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject(drawing);
  });

  test(`${label}봉 최초 조회 실패는 빈 차트와 재시도를 보이며 다른 종목은 사용할 수 있다`, async ({ page, app }) => {
    const response = reply(period);
    await app.fake.respondWith({ ...response, body: FAILURE });
    await app.fake.delay(response.apiId, 700);
    await page.goto(`/?symbol=005930&period=${period}`);
    await expect(cell(page).getByRole("status")).toContainText("봉을 불러오는 중입니다");
    const alert = cell(page).getByRole("alert");
    await expect(alert).toContainText("1501");
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "0");
    await app.fake.respondWith(reply(period, true));
    await page.goto(`/?symbol=IDX:001&period=${period}`);
    await ready(page, `코스피 ${label}`);
    await page.goto(`/?symbol=005930&period=${period}`);
    await expect(alert).toBeVisible();
    await app.fake.respondWith(response);
    await alert.getByRole("button", { name: "다시 시도" }).click();
    await expect(cell(page).getByRole("status")).toContainText("봉을 불러오는 중입니다");
    await ready(page, `삼성전자 통합 ${label}`);
    await expect(alert).toBeHidden();
  });

  test(`${label}봉 과거 조회 도중 실패는 받은 봉을 유지하고 로딩·재시도로 이어 받는다`, async ({ page, app }) => {
    const count = period === "Q" ? 1502 : 501;
    const response = reply(period, false, count, 0, true);
    await app.fake.respondWith(response);
    await page.goto(`/?symbol=005930&period=${period}`);
    await ready(page, `삼성전자 통합 ${label}`);
    const chart = chartOf(cell(page));
    await expect(chart).toHaveAttribute("data-bar-count", "501");
    const before = await chart.getAttribute("data-first-bar-t");
    await app.fake.delay(response.apiId, 700);
    await app.fake.respondWith({ ...response, body: FAILURE });
    await dragTowardPast(page, chart, () => expect(cell(page).getByRole("status")).toContainText("과거 봉을 불러오는 중입니다", { timeout: 500 }));
    const alert = cell(page).getByRole("alert");
    await expect(alert).toContainText("과거 봉을 받지 못했습니다");
    await expect(chart).toHaveAttribute("data-bar-count", "501");
    await expect(chart).toHaveAttribute("data-first-bar-t", before!);
    await expect(cell(page).getByRole("status")).toBeHidden();
    await app.fake.respondWith(reply(period, false, period === "Q" ? 6 : 2, count));
    await alert.getByRole("button", { name: "다시 시도" }).click();
    await expect(cell(page).getByRole("status")).toContainText("과거 봉을 불러오는 중입니다");
    await expect.poll(async () => Number(await chart.getAttribute("data-bar-count"))).toBeGreaterThan(501);
    await expect(alert).toBeHidden();
    await expect(cell(page).getByRole("status")).toBeHidden();
  });
}

test("월·분기·연 주기를 앞뒤로 이동하고 연봉에서 다음 이동이 멈춘다", async ({ page, app }) => {
  for (const { period } of PERIODS) await app.fake.respondWith(reply(period));
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
