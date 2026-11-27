import { financialTest as test, type FinancialFixture } from "./financial-update-helpers";
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { Bar } from "../src/api/generated/Bar";
import { toChartTime } from "../src/chart/time";
import type { ChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, expect, withFirstChart, pickDesktopVenue, pollSaved } from "./harness";
import { expandDock } from "./drawing-probe";

const kst = (date: string) => Date.parse(`${date}T00:00:00+09:00`) / 1000;
const markerId = "01900000-0000-7000-8000-000000000901";
const row = (page: Page, id = "revenue") => page.locator(`[data-indicator-row="${id}"]`);
const data = (financial: FinancialFixture, period: "Y" | "Q" = "Y"): FinancialsPage => financial.page("005930", period);
const drawings = (scenario: Scenario): Drawing[] => scenario.documents.drawings("005930");
interface Mirror { id: string; points: ({ x: number; y: number } | null)[] }
const mirror = async (page: Page): Promise<Mirror[]> => JSON.parse(await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]");
const series = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Histogram").flatMap((s) => s.data).flatMap((p) => "value" in p ? [p.value] : []));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function seed(scenario: Scenario, compare = false, hidden = false) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const settings: ChartSettings = { v: 2, style: "candle", scale: "normal", visibleBars: null, showExtremes: false, showLegend: true, showOhlcChange: false, extremeBasis: "last", showDaySeparators: false, showHorzGrid: true, showVertGrid: true, regularHoursOnly: false, compare: compare ? ["IDX:001"] : [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 2 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: !hidden, style: { colors: ["ind-2"], width: 1 } },
  ], panels: [{ id: "revenue", stretch: 0.4 }] };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "Y", chartSettings: settings }) });
}

function years(scenario: Scenario, count = 9, pageSize = count) {
  const all: Bar[] = Array.from({ length: count }, (_, i) => ({ t: kst(`${2026 - i}-01-01`), o: 180 - i * 10, h: 185 - i * 10, l: 175 - i * 10, c: 180 - i * 10, v: 1000 })).toReversed();
  scenario.on(url => url.pathname === "/api/bars" && url.searchParams.get("period") === "Y", request => {
    const query = new URL(request.url()).searchParams;
    const before = query.has("before") ? Number(query.get("before")) : null;
    const current = before === null ? all.at(-1) ?? null : null;
    const history = all.filter(bar => (current === null || bar.t < current.t) && (before === null || bar.t < before));
    const bars = history.slice(-pageSize);
    const nextBefore = history.length > bars.length ? bars[0]?.t ?? null : null;
    const symbol = query.get("symbol") ?? "005930";
    const venue = symbol.startsWith("IDX:") ? null : "combined";
    return { body: { symbol, venue, period: "Y", bars, current, nextBefore, seq: null } satisfies BarsPage };
  });
}

function marker(scenario: Scenario) {
  const input: DrawingInput = { id: markerId, symbol: "005930", tool: "trendline", points: [{ t: kst("2024-01-01"), price: 155 }, { t: kst("2024-01-01"), price: 165 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
  scenario.documents.saveDrawing(input);
}

async function coordinates(page: Page, time = kst("2024-01-01")) {
  return { candleX: await page.evaluate((t) => window.chartProbe.chart.timeScale().timeToCoordinate(t), toChartTime(time)), drawX: (await mirror(page)).find((d) => d.id === markerId)?.points[0]?.x };
}
async function open(page: Page) {
  await page.addInitScript(installFrameProbe); await page.addInitScript(installChartProbe); await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => !!window.chartProbe)).toBe(true);
  await expect.poll(async () => (await coordinates(page)).drawX).not.toBeUndefined();
}

test.describe("재무 시각과 가격 시각", () => {
  test("가격 밖 재무 시각을 추가·숨김·복원해도 드로잉과 비교 기준 및 가격·기술 툴팁이 일치한다", async ({ page, scenario, financial }, info) => {
    await seed(scenario, true, true); await years(scenario); await marker(scenario);
    await open(page);
    const before = await coordinates(page); expect(before.drawX).toBeCloseTo(before.candleX!, 3);
    await row(page).getByRole("button", { name: / 보이기$/ }).click({ force: true });
    await pollSaved(async () => (await data(financial)).status, { timeout: 60000 }).toBe("ready");
    await expect(row(page)).toContainText("확인 완료");
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 4, to: 10 }));
    const box = (await chartOf(cell(page)).boundingBox())!;
    await frames(page);
    let after = await coordinates(page);
    await page.mouse.move(box.x + after.candleX!, box.y + 200);
    await expect(cell(page)).toContainText("2024-01-01");
    await expect(row(page, "ma")).toContainText("155");
    await frames(page);
    after = await coordinates(page);
    const expected = await page.evaluate(() => {
      const scale = window.chartProbe.chart.timeScale();
      const range = scale.getVisibleLogicalRange()!;
      const base = window.chartProbe.main.dataByIndex(Math.floor(range.from), 1);
      if (!base || !("close" in base)) throw new Error("실제 비교 기준봉이 없습니다");
      return { base, percent: ((160 / base.close - 1) * 100).toFixed(2) };
    });
    const compareRow = page.locator('[data-compare-row="IDX:001"]');
    await expect(compareRow).toContainText(`${expected.percent}%`);
    const compare = await compareRow.innerText();
    expect(after.drawX).toBeCloseTo(after.candleX!, 2);
    const right = await page.evaluate(() => window.chartProbe.chart.timeScale().width()) - after.candleX!;
    for (const title of ["숨기기", "보이기"]) {
      await row(page).getByRole("button", { name: new RegExp(` ${title}$`) }).click({ force: true }); await frames(page);
      const restored = await coordinates(page);
      expect(restored.drawX).toBeCloseTo(restored.candleX!, 2);
      expect(await page.evaluate(() => window.chartProbe.chart.timeScale().width()) - restored.candleX!).toBeCloseTo(right, 2);
    }
    await writeFile(info.outputPath("axis-evidence.json"), JSON.stringify({ before, after, expected, compare }, null, 2));
    if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("axis.png") });
  });

  test("과거 가격 조회가 이미 존재하는 재무 시각을 채워도 화면 범위와 저장 드로잉을 보존한다", async ({ page, scenario }, info) => {
    await seed(scenario, true); years(scenario, 12, 5); await marker(scenario);
    let holding = true;
    const held = scenario.hold(url => url.pathname === "/api/bars" && url.searchParams.has("before") && holding);
    await open(page);
    await expect(row(page)).toContainText("확인 완료", { timeout: 45000 });
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "6");
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 4, to: 10 }));
    const older = await held.received;
    holding = false;
    const olderPage = await scenario.respond(older);
    await frames(page);
    const before = await coordinates(page);
    const metrics = () => page.evaluate(() => ({ width: window.chartProbe.chart.timeScale().width(), spacing: window.chartProbe.chart.timeScale().options().barSpacing, range: window.chartProbe.chart.timeScale().getVisibleLogicalRange(), visible: window.chartProbe.chart.timeScale().getVisibleRange() }));
    const initial = await metrics();
    held.reply(olderPage);
    await expect.poll(async () => Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(6);
    await frames(page);
    const after = await coordinates(page);
    const current = await metrics();
    await writeFile(info.outputPath("prepend-evidence.json"), JSON.stringify({ before, after, initial, current }, null, 2));
    expect(current.width - after.candleX!).toBeCloseTo(initial.width - before.candleX!, 2);
    expect(after.drawX).toBeCloseTo(after.candleX!, 2);
    expect(await page.evaluate(() => window.chartProbe.chart.timeScale().options().barSpacing)).toBeCloseTo(initial.spacing, 3);
    expect((await drawings(scenario))[0]!.points[0]!.t).toBe(kst("2024-01-01"));
    await writeFile(info.outputPath("prepend-evidence.json"), JSON.stringify({ before, after, initial, current, count: await chartOf(cell(page)).getAttribute("data-bar-count") }, null, 2));
  });

  test("재무 차트에서 자석 스냅과 핸들 드래그는 실제 가격 시각을 저장한다", async ({ page, scenario }, info) => {
    await seed(scenario); await years(scenario); await marker(scenario); await open(page);
    await expect(row(page)).toContainText("확인 완료");
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 13 }));
    await frames(page);
    const box = (await chartOf(cell(page)).boundingBox())!;
    const move = async (year: number, price: number) => {
      const point = await page.evaluate(({ t, price }) => ({ x: window.chartProbe.chart.timeScale().timeToCoordinate(t), y: window.chartProbe.main.priceToCoordinate(price) }), { t: toChartTime(kst(`${year}-01-01`)), price });
      if (point.x === null || point.y === null) throw new Error("실제 시각의 좌표가 없습니다");
      return { x: box.x + point.x, y: box.y + point.y };
    };
    await expandDock(page);
    await page.getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
    await page.getByRole("menuitemradio", { name: "강", exact: true }).click();
    const start = await move(2021, 132); const end = await move(2023, 152);
    await cell(page).focus(); await page.keyboard.press("T");
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    await pollSaved(async () => (await drawings(scenario)).length).toBe(2);
    const created = (await drawings(scenario)).find((d) => d.id !== markerId)!;
    expect(created.points).toEqual([{ t: kst("2021-01-01"), price: 130 }, { t: kst("2023-01-01"), price: 150 }]);
    const target = await move(2024, 163);
    const handle = await move(2023, 150);
    await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up();
    await pollSaved(async () => (await drawings(scenario)).find((d) => d.id === created.id)!.points[1]).toEqual({ t: kst("2024-01-01"), price: 165 });
    await writeFile(info.outputPath("magnet-editing-evidence.json"), JSON.stringify({ created, edited: (await drawings(scenario)).find((d) => d.id === created.id) }, null, 2));
  });

  test("재무 과거·미래 여백 영역에 그린 드로잉도 실제 시각을 저장한다", async ({ page, scenario }, info) => {
    await seed(scenario); await years(scenario); await marker(scenario); await open(page);
    await expect(row(page)).toContainText("확인 완료");
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 13 }));
    await frames(page);
    const box = (await chartOf(cell(page)).boundingBox())!;
    const move = async (year: number, price: number) => {
      const point = await page.evaluate(({ t, price }) => ({ x: window.chartProbe.chart.timeScale().timeToCoordinate(t), y: window.chartProbe.main.priceToCoordinate(price) }), { t: toChartTime(kst(`${year}-01-01`)), price });
      if (point.x === null || point.y === null) throw new Error("실제 시각의 좌표가 없습니다");
      return { x: box.x + point.x, y: box.y + point.y };
    };
    await expandDock(page);
    await page.getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
    await page.getByRole("menuitemradio", { name: "강", exact: true }).click();
    const old = await move(2015, 150);
    old.x += await page.evaluate(() => window.chartProbe.chart.timeScale().options().barSpacing / 4);
    await cell(page).focus(); await page.keyboard.press("T");
    await page.mouse.move(old.x, old.y); await page.mouse.down(); await page.mouse.move(old.x + 1, old.y - 20); await page.mouse.up();
    await pollSaved(async () => (await drawings(scenario)).length).toBe(2);
    const historical = (await drawings(scenario)).find((d) => d.id !== markerId)!;
    expect(Math.abs(historical.points[0]!.t - (kst("2015-01-01") + 365 * 86400 / 4))).toBeLessThan(7 * 86400);
    const projected = (await mirror(page)).find((d) => d.id === historical.id)!;
    expect(projected.points[0]!.x).toBeCloseTo(old.x - box.x, 1);

    await page.keyboard.press("Escape");
    await expandDock(page);
    const magnet = page.getByRole("button", { name: "자석", exact: true });
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "false");
    const future = await page.evaluate((t) => {
      const scale = window.chartProbe.chart.timeScale();
      const last = scale.timeToIndex(t, false)!;
      const index = last + 2;
      const isLogical = (n: number): n is Parameters<typeof scale.logicalToCoordinate>[0] => Number.isFinite(n);
      if (!isLogical(index)) throw new Error("잘못된 미래 인덱스");
      return { x: scale.logicalToCoordinate(index), y: window.chartProbe.main.priceToCoordinate(150) };
    }, toChartTime(kst("2026-01-01")));
    if (future.x === null || future.y === null) throw new Error("미래 좌표가 없습니다");
    await cell(page).focus(); await page.keyboard.press("T");
    await page.mouse.move(box.x + future.x, box.y + future.y); await page.mouse.down(); await page.mouse.move(box.x + future.x + 1, box.y + future.y - 20); await page.mouse.up();
    await pollSaved(async () => (await drawings(scenario)).length).toBe(3);
    const futureDrawing = (await drawings(scenario)).find((d) => d.id !== markerId && d.id !== historical.id)!;
    expect(Math.abs(futureDrawing.points[0]!.t - kst("2028-01-01"))).toBeLessThan(7 * 86400);
    await writeFile(info.outputPath("margin-editing-evidence.json"), JSON.stringify({ historical, projected, futureDrawing }, null, 2));
  });
});

test.describe("같은 재무 키의 응답 순서", () => {
  test("Q/Y·거래소 전환 뒤에도 값과 상태가 유지되고 일봉에서는 재무를 다시 요청하지 않는다", async ({ page, scenario }, info) => {
    await seed(scenario);
    await page.clock.install({ time: scenario.now });
    await page.addInitScript(installFrameProbe);
    await page.goto("/");
    await expect(row(page)).toContainText("확인 완료");
    await expect.poll(() => series(page)).not.toEqual([]);
    const annual = await series(page);
    const periods = page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
    await periods.getByRole("button", { name: "분기", exact: true }).click();
    await expect(row(page)).toContainText("확인 완료");
    await expect.poll(() => series(page)).not.toEqual(annual);
    const quarter = await series(page);
    const requests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/financials")) requests.push(request.url()); });
    const krxBars = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/bars" && url.searchParams.get("symbol") === "005930" && url.searchParams.get("venue") === "krx" && url.searchParams.get("period") === "Q" && !url.searchParams.has("before");
    });
    await pickDesktopVenue(page, "KRX");
    expect((await krxBars).ok()).toBe(true);
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => series(page)).toEqual(quarter);
    await periods.getByRole("button", { name: "일", exact: true }).click();
    await expect(row(page)).toHaveCount(0);
    await page.clock.fastForward(1500);
    expect(requests).toEqual([]);
    await periods.getByRole("button", { name: "연", exact: true }).click();
    await expect(row(page)).toContainText("확인 완료");
    await expect.poll(() => series(page)).toEqual(annual);
    await writeFile(info.outputPath("period-switch.json"), JSON.stringify({ annual, quarter, requests }, null, 2));
  });
});
