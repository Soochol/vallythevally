import { financialListings, startUpdate, settleUpdate, updateFromChart } from "./financial-update-helpers";
import { selectOption } from "./select-option";
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import type { DrawingInput } from "../src/api/generated/DrawingInput";
import type { FinancialUpdatePage } from "../src/api/generated/FinancialUpdatePage";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { Layout } from "../src/api/generated/Layout";
import { toChartTime } from "../src/chart/time";
import type { ChartSettings } from "../src/chart/settings";
import { installChartProbe } from "./chart-probe";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const kst = (date: string) => Date.parse(`${date}T00:00:00+09:00`) / 1000;
const markerId = "01900000-0000-7000-8000-000000000901";
const row = (page: Page, id = "revenue") => page.locator(`[data-indicator-row="${id}"]`);
const data = async (app: App, period = "Y"): Promise<FinancialsPage> => (await fetch(`${app.url}/api/symbols/005930/financials?period=${period}`)).json();
const drawings = async (app: App): Promise<Drawing[]> => (await fetch(`${app.url}/api/drawings?symbol=005930`)).json();
interface Mirror { id: string; points: ({ x: number; y: number } | null)[] }
const mirror = async (page: Page): Promise<Mirror[]> => JSON.parse(await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]");
const series = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Histogram").flatMap((s) => s.data).flatMap((p) => "value" in p ? [p.value] : []));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function seed(app: App, compare = false, hidden = false) {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const settings: ChartSettings = { v: 2, style: "candle", scale: "normal", compare: compare ? ["IDX:001"] : [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 2 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: !hidden, style: { colors: ["ind-2"], width: 1 } },
  ], panels: [{ id: "revenue", stretch: 0.4 }] };
  expect((await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "005930", venue: "combined", period: "Y", chartSettings: settings }] }) })).ok).toBe(true);
  await startUpdate(app, true);
  await app.restart({ clockStart: "20261109100030" });
}

async function years(app: App, count = 9, offset = 0, more = false) {
  for (const index of [false, true]) await app.fake.respondWith({ apiId: index ? "ka20019" : "ka10094", status: 200, body: { return_code: 0, return_msg: "synthetic", ...(index ? { inds_cd: "001" } : { stk_cd: "005930_AL" }), [index ? "inds_yr_pole_qry" : "stk_yr_pole_chart_qry"]: Array.from({ length: count }, (_, i) => ({ dt: `${2026 - offset - i}0101`, open_pric: String(180 - (i + offset) * 10), high_pric: String(185 - (i + offset) * 10), low_pric: String(175 - (i + offset) * 10), cur_prc: String(180 - (i + offset) * 10), trde_qty: "1000" })), _headers: { "cont-yn": more ? "Y" : "N", "next-key": more ? "OLDER" : "" } } });
}
async function marker(app: App) {
  const input: DrawingInput = { id: markerId, symbol: "005930", tool: "trendline", points: [{ t: kst("2024-01-01"), price: 155 }, { t: kst("2024-01-01"), price: 165 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
  expect((await fetch(`${app.url}/api/drawings/${input.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).ok).toBe(true);
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
  test.use({ financialFixture: true, bootReplies: [financialListings], clockStart: "20171231120000" });
  test("가격 밖 재무 시각을 추가·숨김·복원해도 드로잉과 비교 기준 및 가격·기술 툴팁이 일치한다", async ({ page, app }, info) => {
    await seed(app, true, true); await years(app); await marker(app);
    const calls = app.dart!.calls.length;
    await open(page);
    const before = await coordinates(page); expect(before.drawX).toBeCloseTo(before.candleX!, 3);
    expect(app.dart!.calls).toHaveLength(calls);
    await row(page).getByTitle("보이기", { exact: true }).click({ force: true });
    await startUpdate(app);
    await expect.poll(async () => (await data(app)).status, { timeout: 60000 }).toBe("ready");
    await expect(row(page)).toContainText("확인 완료");
    expect((await data(app)).series[0]!.points.some((p) => p.priceBucket === kst("2015-01-01") && p.value !== null)).toBe(true);
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
    const compare = await page.locator('[data-compare-row="IDX:001"]').innerText();
    expect(after.drawX).toBeCloseTo(after.candleX!, 2);
    expect(compare).toContain(`${expected.percent}%`);
    const right = await page.evaluate(() => window.chartProbe.chart.timeScale().width()) - after.candleX!;
    for (const title of ["숨기기", "보이기"]) {
      await row(page).getByTitle(title, { exact: true }).click({ force: true }); await frames(page);
      const restored = await coordinates(page);
      expect(restored.drawX).toBeCloseTo(restored.candleX!, 2);
      expect(await page.evaluate(() => window.chartProbe.chart.timeScale().width()) - restored.candleX!).toBeCloseTo(right, 2);
    }
    await writeFile(info.outputPath("axis-evidence.json"), JSON.stringify({ before, after, expected, compare }, null, 2));
    await page.screenshot({ path: info.outputPath("axis.png") });
  });

  test("과거 가격 조회가 이미 존재하는 재무 시각을 채워도 화면 범위와 저장 드로잉을 보존한다", async ({ page, app }, info) => {
    await seed(app, true); await years(app, 12); await marker(app);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested: () => void = () => {};
    const olderRequested = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/api/bars?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("before")) { requested(); await held; }
      url.searchParams.set("limit", "5");
      await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
    });
    await open(page);
    await expect(row(page)).toContainText("확인 완료", { timeout: 45000 });
    await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", "6");
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 4, to: 10 }));
    await olderRequested; await frames(page);
    const before = await coordinates(page);
    const metrics = () => page.evaluate(() => ({ width: window.chartProbe.chart.timeScale().width(), spacing: window.chartProbe.chart.timeScale().options().barSpacing, range: window.chartProbe.chart.timeScale().getVisibleLogicalRange(), visible: window.chartProbe.chart.timeScale().getVisibleRange() }));
    const initial = await metrics();
    release();
    await expect.poll(async () => Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(6);
    await frames(page);
    const after = await coordinates(page);
    const current = await metrics();
    await writeFile(info.outputPath("prepend-evidence.json"), JSON.stringify({ before, after, initial, current }, null, 2));
    expect(current.width - after.candleX!).toBeCloseTo(initial.width - before.candleX!, 2);
    expect(after.drawX).toBeCloseTo(after.candleX!, 2);
    expect(await page.evaluate(() => window.chartProbe.chart.timeScale().options().barSpacing)).toBeCloseTo(initial.spacing, 3);
    expect((await drawings(app))[0]!.points[0]!.t).toBe(kst("2024-01-01"));
    await writeFile(info.outputPath("prepend-evidence.json"), JSON.stringify({ before, after, initial, current, count: await chartOf(cell(page)).getAttribute("data-bar-count") }, null, 2));
  });

  test("재무 과거·미래 시각에서도 양방향 배치와 자석·핸들 편집은 실제 가격 시각을 저장한다", async ({ page, app }, info) => {
    await seed(app); await years(app); await marker(app); await open(page);
    await expect(row(page)).toContainText("확인 완료", { timeout: 45000 });
    await page.evaluate(() => window.chartProbe.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 13 }));
    await frames(page);
    const box = (await chartOf(cell(page)).boundingBox())!;
    const move = async (year: number, price: number) => {
      const point = await page.evaluate(({ t, price }) => ({ x: window.chartProbe.chart.timeScale().timeToCoordinate(t), y: window.chartProbe.main.priceToCoordinate(price) }), { t: toChartTime(kst(`${year}-01-01`)), price });
      if (point.x === null || point.y === null) throw new Error("실제 시각의 좌표가 없습니다");
      return { x: box.x + point.x, y: box.y + point.y };
    };
    await page.getByRole("button", { name: "자석", exact: true }).click({ button: "right" });
    await page.getByRole("menuitemradio", { name: "강", exact: true }).click();
    const start = await move(2021, 132); const end = await move(2023, 152);
    await cell(page).focus(); await page.keyboard.press("T");
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await drawings(app)).length).toBe(2);
    const created = (await drawings(app)).find((d) => d.id !== markerId)!;
    expect(created.points).toEqual([{ t: kst("2021-01-01"), price: 130 }, { t: kst("2023-01-01"), price: 150 }]);
    const target = await move(2024, 163);
    const handle = await move(2023, 150);
    await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await drawings(app)).find((d) => d.id === created.id)!.points[1]).toEqual({ t: kst("2024-01-01"), price: 165 });
    await page.keyboard.press("Escape");
    const magnet = page.getByRole("button", { name: "자석", exact: true });
    const old = await move(2015, 150);
    old.x += await page.evaluate(() => window.chartProbe.chart.timeScale().options().barSpacing / 4);
    await cell(page).focus(); await page.keyboard.press("T");
    await page.mouse.move(old.x, old.y); await page.mouse.down(); await page.mouse.move(old.x + 1, old.y - 20); await page.mouse.up();
    await expect.poll(async () => (await drawings(app)).length).toBe(3);
    const historical = (await drawings(app)).find((d) => d.id !== markerId && d.id !== created.id)!;
    expect(Math.abs(historical.points[0]!.t - (kst("2015-01-01") + 365 * 86400 / 4))).toBeLessThan(7 * 86400);
    const projected = (await mirror(page)).find((d) => d.id === historical.id)!;
    expect(projected.points[0]!.x).toBeCloseTo(old.x - box.x, 1);
    await page.keyboard.press("Escape");
    if (await magnet.getAttribute("aria-pressed") === "true") await magnet.click();
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
    await expect.poll(async () => (await drawings(app)).length).toBe(4);
    const futureDrawing = (await drawings(app)).find((d) => ![markerId, created.id, historical.id].includes(d.id))!;
    expect(Math.abs(futureDrawing.points[0]!.t - kst("2028-01-01"))).toBeLessThan(7 * 86400);
    await writeFile(info.outputPath("editing-evidence.json"), JSON.stringify({ created, edited: (await drawings(app)).find((d) => d.id === created.id), historical, projected, futureDrawing }, null, 2));
  });
});

test.describe("같은 재무 키의 응답 순서", () => {
  test.use({ financialFixture: true, bootReplies: [financialListings], clockStart: "20171231120000" });
  test("중첩 POST와 늦은 GET이 최신 정정의 빈 값과 사유를 되돌리지 않는다", async ({ page, app }, info) => {
    await seed(app); await page.addInitScript(installFrameProbe); await page.goto("/");
    await expect(row(page)).toContainText("확인 완료", { timeout: 45000 });
    const original = await data(app);
    let releaseFirst: () => void = () => {}; const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let receivedFirst: () => void = () => {}; const firstReceived = new Promise<void>((resolve) => { receivedFirst = resolve; });
    let releaseGets: () => void = () => {}; const getHeld = new Promise<void>((resolve) => { releaseGets = resolve; });
    let blockGets = false; let posts = 0;
    const responses: FinancialUpdatePage[] = [];
    await page.route("**/api/financial-update", async (route) => {
      if (route.request().method() === "POST") {
        const n = ++posts; const response = await route.fetch(); responses.push(await response.json());
        if (n === 1) { receivedFirst(); await firstHeld; }
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page.route("**/api/symbols/005930/financials?period=Y", async (route) => { if (blockGets) await getHeld; await route.continue(); });
    await row(page).locator("summary").click();
    const refresh = () => updateFromChart(page);
    app.dart!.edge = true;
    await refresh(); await firstReceived; await settleUpdate(app);
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    await refresh(); await expect.poll(() => posts).toBe(2); await settleUpdate(app);
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    await expect(row(page)).toContainText("확인 완료");
    await expect.poll(() => series(page)).toEqual([]);
    const corrected = await series(page);
    const delivered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/financial-update"));
    blockGets = true; releaseFirst(); await delivered; await frames(page);
    const after = await series(page); const server = await data(app);
    expect(after).toEqual(corrected);
    expect(after).not.toContain(1000);
    await expect(row(page)).toContainText("확인 완료");
    const points = server.series.find((s) => s.metric === "revenue")!.points;
    expect(points.some((p) => p.reason === "period_overlap" && p.value === null)).toBe(true);
    await selectOption(row(page).getByRole("combobox"), { index: 1 });
    await expect(row(page).locator("details")).toContainText("보고기간이 겹쳐 표시 불가");
    await writeFile(info.outputPath("mutation-order.json"), JSON.stringify({ original, responses, corrected, after, server }, null, 2));
    releaseGets();
  });

  test("늦은 GET은 수동 정정과 Q/Y·거래소 전환 뒤의 값과 상태를 덮지 않는다", async ({ page, app }, info) => {
    await seed(app);
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let received: () => void = () => {};
    const receivedGet = new Promise<void>((resolve) => { received = resolve; });
    let delivered: () => void = () => {};
    const deliveredGet = new Promise<void>((resolve) => { delivered = resolve; });
    let reads = 0;
    let old: FinancialsPage | null = null;
    await page.route("**/api/symbols/005930/financials?period=Y", async (route) => {
      if (route.request().method() === "GET" && ++reads === 1) {
        const response = await route.fetch(); old = await response.json(); received(); await held;
        await route.fulfill({ response }); delivered();
      } else await route.continue();
    });
    await page.addInitScript(installFrameProbe); await page.goto("/"); await receivedGet;
    app.dart!.edge = true;
    await row(page).locator("summary").click();
    await updateFromChart(page);
    await settleUpdate(app);
    await expect(row(page)).toContainText("확인 완료");
    await expect.poll(() => series(page)).toEqual([]);
    release(); await deliveredGet; await frames(page);
    expect(await series(page)).toEqual([]);
    await expect(row(page)).toContainText("확인 완료");
    await row(page).locator("summary").click();
    const periods = page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
    await periods.getByRole("button", { name: "분기", exact: true }).click();
    await expect(row(page)).toContainText("확인 완료");
    const quarter = await series(page);
    const requests: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/financials?")) requests.push(r.url()); });
    await page.getByRole("group", { name: "거래소", exact: true }).getByRole("button", { name: "KRX", exact: true }).click();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    expect(await series(page)).toEqual(quarter);
    await periods.getByRole("button", { name: "일", exact: true }).click();
    await expect(row(page)).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect(requests).toEqual([]);
    await periods.getByRole("button", { name: "연", exact: true }).click();
    await expect(row(page)).toContainText("확인 완료");
    expect(await series(page)).toEqual([]);
    await writeFile(info.outputPath("late-get.json"), JSON.stringify({ old, current: await data(app), quarter, requests }, null, 2));
  });

 test("cold Y 조회를 수동 갱신 중 재활성화해도 최신 정정의 빈 값으로 확인한다",async({page,app},info)=>{
  await seed(app); await expect.poll(async()=>(await data(app)).status).toBe("ready");
  const deferred=()=>{let release:()=>void=()=>{};const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
  const first=deferred(),second=deferred(),postStart=deferred(),postDelivery=deferred();
  let reads=0,postSeen=false,postFetched=false; const oldResponses:FinancialsPage[]=[]; let postResponse:FinancialUpdatePage|null=null; const events:string[]=[];
  await page.route("**/api/financial-update",async route=>{
    if(route.request().method()==="POST") {
      postSeen=true; events.push("POST requested and held before server"); await postStart.promise; const response=await route.fetch(); postResponse=await response.json(); postFetched=true; events.push("POST server response captured"); await postDelivery.promise; await route.fulfill({response}); events.push("POST delivered");
    } else await route.continue();
  });
  await page.route("**/api/symbols/005930/financials?period=Y",async route=>{
      const n=++reads; const response=await route.fetch(); oldResponses.push(await response.json()); events.push(`GET ${n} server snapshot captured`);
      if(n===1) await first.promise; if(n===2) await second.promise;
      await route.fulfill({response}); events.push(`GET ${n} delivered`);
  });
  await page.addInitScript(installFrameProbe); await page.goto("/"); await expect.poll(()=>oldResponses.length).toBe(1);
  await row(page).locator("summary").click(); app.dart!.edge=true;
  await updateFromChart(page); await expect.poll(()=>postSeen).toBe(true);
  await page.keyboard.press("Escape");
  await expect(row(page).locator("details")).not.toHaveAttribute("open", "");
  const periods=page.getByRole("toolbar").getByRole("group",{name:"봉 주기"});
  await periods.getByRole("button",{name:"일",exact:true}).click(); await expect(row(page)).toHaveCount(0);
  await periods.getByRole("button",{name:"연",exact:true}).click(); await expect.poll(()=>oldResponses.length).toBe(2);
  postStart.release(); await expect.poll(()=>postFetched).toBe(true); await settleUpdate(app); await expect.poll(async()=>(await data(app)).status).toBe("ready");
  const delivered=page.waitForResponse(r=>r.request().method()==="POST"&&r.url().includes("/financial-update"));
  postDelivery.release(); await delivered; await frames(page);
  second.release(); await expect(row(page)).toContainText("확인 완료"); await frames(page);
  await page.waitForTimeout(2200);
  const actual=await series(page),server=await data(app);
  await writeFile(info.outputPath("cold-race.json"),JSON.stringify({events,oldResponses,postResponse,actual,server,reads},null,2));
  first.release();
  expect(server.series.find(s=>s.metric==="revenue")!.points.some(p=>p.value===null&&p.reason==="period_overlap")).toBe(true);
  expect(actual).toEqual([]);
 });
});
