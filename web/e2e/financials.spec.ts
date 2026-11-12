import { selectOption } from "./select-option";
import type { Page } from "@playwright/test";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { Layout } from "../src/api/generated/Layout";
import { parseChartSettings, type ChartSettings } from "../src/chart/settings";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

const METRICS = ["revenue", "operating_income", "owner_roe", "investing_cash_flow", "dps", "debt_ratio"] as const;
const LABELS = ["매출액", "영업이익", "지배주주 ROE", "투자활동 현금흐름", "DPS", "부채비율"];
const row = (page: Page, id: string) => page.locator(`[data-indicator-row="${id}"]`);
const data = async (app: App, symbol = "005930", period = "Y"): Promise<FinancialsPage> => (await fetch(`${app.url}/api/symbols/${symbol}/financials?period=${period}`)).json();

async function seed(app: App, period = "Y") {
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    { id: "ma", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
    ...METRICS.map((kind) => ({ id: kind, spec: { kind }, panel: kind, visible: true, style: { colors: ["ind-2"], width: 1 } } satisfies ChartSettings["indicators"][number])),
  ], panels: METRICS.map((id) => ({ id, stretch: 0.3 })) };
  const result = await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "005930", venue: "combined", period, chartSettings }] }) });
  expect(result.ok).toBe(true);
  return chartSettings;
}

async function choosePeriod(page: Page, phone: boolean, label: string) {
  const group = phone ? page.getByRole("navigation", { name: "봉 주기" }) : page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
  const button = group.getByRole("button", { name: label, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function refresh(page: Page) {
  const detail = row(page, "revenue").locator("details");
  if (await detail.getAttribute("open") === null) await detail.locator("summary").click();
  await detail.getByRole("button", { name: /재무자료 새로고침/ }).click();
  await detail.locator("summary").click();
}

for (const phone of [false, true]) test.describe(phone ? "휴대폰 재무지표" : "데스크톱 재무지표", () => {
  test.use({ financialFixture: true, clockStart: "20171231120000", ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });

  test("메뉴 6종 추가·Q/D/Y 숨김 복원·음수와 0·설정 재열기", async ({ page, app }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(installFrameProbe);
    await page.goto("/?symbol=005930&period=Q");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    expect(app.dart!.calls).toHaveLength(0);
    await page.getByRole("button", { name: /^지표/ }).first().click();
    const dialog = page.getByRole("dialog");
    for (const label of LABELS) {
      await dialog.getByRole("option", { name: label, exact: true }).click();
      await dialog.getByRole("button", { name: `${label} 추가`, exact: true }).click();
    }
    await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
    await expect(page.locator("[data-indicator-row]")).toHaveCount(7);
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    await expect(page.locator("[data-indicator-row]").filter({ hasText: "DPS" })).toContainText("연간 전용");
    await choosePeriod(page, phone, "일");
    await expect(page.locator("[data-indicator-row]")).toHaveCount(1);
    await choosePeriod(page, phone, "연");
    await expect(page.locator("[data-indicator-row]")).toHaveCount(7);
    await expect.poll(() => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Histogram").flatMap((s) => s.data).some((p) => "value" in p && p.value < 0))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Histogram").flatMap((s) => s.data).some((p) => "value" in p && p.value === 0))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("financial-panels.png") });
    if (!phone) {
      const separator = cell(page).locator('div[style*="cursor: row-resize"][style*="position: absolute"]').nth(1);
      const box = await separator.boundingBox();
      if (!box) throw new Error("재무 패널 높이 조절선이 없습니다");
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2 - 15, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => {
        const saved: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
        return parseChartSettings(saved.cells[0]!.chartSettings).panels.some((p) => p.stretch !== 0.25);
      }).toBe(true);
      await choosePeriod(page, phone, "일");
      await choosePeriod(page, phone, "연");
    }
    const revenue = page.locator("[data-indicator-row]").filter({ hasText: /^매출액/ });
    await revenue.getByRole("button", { name: /패널 아래로/ }).click({ force: true });
    await revenue.getByRole("button", { name: /숨기기/ }).click({ force: true });
    await expect.poll(async () => {
      const saved: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
      const settings = parseChartSettings(saved.cells[0]!.chartSettings);
      return settings.indicators.find((i) => i.spec.kind === "revenue")?.visible;
    }).toBe(false);
    const before: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    await app.restart();
    await page.reload();
    await expect(page.locator("[data-indicator-row]")).toHaveCount(7);
    await expect(page.locator("[data-indicator-row]").filter({ hasText: /^매출액/ }).getByRole("button", { name: /보이기/ })).toHaveCount(1);
    const after: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    expect(after.cells[0]!.chartSettings).toEqual(before.cells[0]!.chartSettings);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(errors).toEqual([]);
  });

  test("수집과 최초·도중·갱신 실패가 가격·다른 지표를 막지 않고 재시도로 복구", async ({ page, app }) => {
    app.dart!.delay = 25;
    let release: () => void = () => {};
    app.dart!.block = { scope: "fnlttSinglAcntAll.json/2016/11011", wait: new Promise<void>((resolve) => { release = resolve; }) };
    app.dart!.fail = "fnlttSinglAcntAll.json/2015/11013";
    await seed(app);
    await page.addInitScript(installFrameProbe);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(row(page, "revenue")).toContainText("수집 중");
    await choosePeriod(page, phone, "분기");
    await expect(row(page, "dps")).toContainText("연간 전용");
    await expect.poll(() => page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Histogram").flatMap((s) => s.data).some((p) => "value" in p && p.value === 100))).toBe(true);
    await expect(row(page, "revenue")).toContainText("수집 중");
    release();
    app.dart!.block = null;
    await expect.poll(async () => (await data(app)).status).toBe("partial_failure");
    await expect(row(page, "revenue")).toContainText("일부 조회 실패");
    expect(Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
    const partial = await data(app, "005930", "Q");
    expect(partial.series.find((s) => s.metric === "revenue")!.points.some((p) => p.status === "failed")).toBe(true);
    expect(partial.series.find((s) => s.metric === "debt_ratio")!.points.some((p) => p.value === 50)).toBe(true);
    app.dart!.fail = null;
    await refresh(page);
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    await expect(row(page, "revenue")).toContainText("확인 완료");
    const confirmed = await data(app);
    app.dart!.fail = "list.json";
    await refresh(page);
    await expect(row(page, "revenue")).toContainText("갱신 실패");
    const stale = await data(app);
    expect(stale.series.map((s) => s.points.map((p) => p.value))).toEqual(confirmed.series.map((s) => s.points.map((p) => p.value)));
    await choosePeriod(page, phone, "일");
    await expect(row(page, "ma")).toBeVisible();
    await choosePeriod(page, phone, "연");
    app.dart!.fail = null;
    await refresh(page);
    await expect(row(page, "revenue")).toContainText("확인 완료");
    await row(page, "revenue").locator("summary").click();
    await expect(row(page, "revenue").locator("details")).toContainText("마지막 확인");
    await selectOption(row(page, "revenue").getByRole("combobox"), { index: 1 });
    await expect(row(page, "revenue").locator("details")).toContainText("접수번호");
    await expect(row(page, "revenue").locator("details")).toContainText("KRW");
  });
});

test.describe("재무지원 경계", () => {
  test.use({ financialFixture: true, clockStart: "20171231120000" });
  test("종목·종류·거래소 전환은 설정을 유지하고 우선주 DPS와 ETF·지수를 안내", async ({ page, app }) => {
    const settings = await seed(app);
    await page.goto("/");
    await expect.poll(async () => (await data(app)).status).toBe("ready");
    for (const symbol of ["005935", "0000D0", "IDX:001", "000020", "005930"]) {
      await page.goto(`/?symbol=${symbol}`);
      await expect(cell(page)).toHaveAttribute("aria-busy", "false");
      if (symbol === "005935") {
        await expect(row(page, "dps")).toContainText("확인 완료");
        await row(page, "dps").locator("summary").click();
        await selectOption(row(page, "dps").getByRole("combobox"), { index: 2 });
        await expect(row(page, "dps").locator("details")).toContainText("주식 종류 미확인");
      } else if (symbol === "0000D0" || symbol === "IDX:001") await expect(row(page, "revenue")).toContainText("미지원");
      else await expect(row(page, "revenue")).toContainText("확인 완료");
    }
    await page.getByRole("group", { name: "거래소", exact: true }).getByRole("button", { name: "KRX", exact: true }).click();
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(row(page, "revenue")).toContainText("확인 완료");
    await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
    const etn = await fetch(`${app.url}/api/symbols/500095/financials?period=Y`);
    expect(etn.status).toBe(404);
    expect((await etn.json()).error.code).toBe("unknown_symbol");
    const stored: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
    expect(stored.cells[0]!.chartSettings).toEqual(settings);
  });

  test("처음 회사 조회가 실패해도 가격과 다른 회사는 사용할 수 있다", async ({ page, app }) => {
    app.dart!.fail = "/00126380";
    await seed(app);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(row(page, "revenue")).toContainText("조회 실패");
    await expect(row(page, "revenue")).not.toContainText("저장 자료 유지");
    await expect(row(page, "ma")).toBeVisible();
    await page.goto("/?symbol=000020");
    await expect(row(page, "revenue")).toContainText("확인 완료");
    await expect(row(page, "revenue")).toContainText("3월 결산");
    app.dart!.fail = null;
    await page.goto("/?symbol=005930");
    await refresh(page);
    await expect(row(page, "revenue")).toContainText("확인 완료");
  });

  test("이전 종목의 늦은 응답이 새 회사의 패널에 그려지지 않는다", async ({ page, app }) => {
    await seed(app);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let waiting: () => void = () => {};
    const received = new Promise<void>((resolve) => { waiting = resolve; });
    await page.route("**/api/symbols/005930/financials?*", async (route) => {
      const response = await route.fetch();
      waiting();
      await held;
      await route.fulfill({ response });
    });
    await page.goto("/");
    await received;
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.getByTitle(SEARCH_BUTTON_TITLE).click();
    const search = page.getByRole("dialog", { name: "종목 검색" });
    await search.getByRole("combobox").fill("000020");
    await search.getByRole("option").filter({ hasText: "000020" }).click();
    await expect(row(page, "revenue")).toContainText("3월 결산");
    await expect(row(page, "revenue")).toContainText("확인 완료");
    release();
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 동화약품 통합 연");
    await expect(row(page, "revenue")).toContainText("3월 결산");
    expect((await data(app, "000020")).corpCode).toBe("00000002");
  });

  test("결산월·기준변경·기간겹침·분모 0은 원금액과 사유를 보이고 빈칸을 연결하지 않는다", async ({ page, app }) => {
    app.dart!.edge = true;
    await seed(app, "Q");
    await page.addInitScript(installFrameProbe);
    await page.goto("/");
    await expect.poll(async () => (await data(app, "005930", "Q")).status).toBe("ready");
    await expect(row(page, "debt_ratio")).toContainText("3월 결산");
    await row(page, "debt_ratio").locator("summary").click();
    const points = (await data(app, "005930", "Q")).series.find((s) => s.metric === "debt_ratio")!.points;
    const i = points.findIndex((p) => p.reason === "non_positive_equity");
    expect(i).toBeGreaterThanOrEqual(0);
    await selectOption(row(page, "debt_ratio").getByRole("combobox"), { index: i + 1 });
    await expect(row(page, "debt_ratio").locator("details")).toContainText("자본총계가 0 이하");
    await expect(row(page, "debt_ratio").locator("details")).toContainText("부채총계: 200 KRW");
    await expect(row(page, "debt_ratio").locator("details")).toContainText("자본총계: 0 KRW");
    const result = await data(app, "005930", "Q");
    expect(result.series.flatMap((s) => s.points).some((p) => p.reason === "period_overlap")).toBe(true);
    expect(result.series.flatMap((s) => s.points).some((p) => p.reason === "basis_changed")).toBe(true);
    expect(await page.evaluate(() => window.frameProbe.snapshot().filter((s) => s.type === "Custom").flatMap((s) => s.data).some((p) => "connect" in p && p.connect === false))).toBe(true);
    const shifted = result.series.find((s) => s.metric === "revenue")!.points.find((p) => p.businessYear === 2015 && p.reportCode === "11011")!;
    expect(shifted.period).toEqual({ kind: "duration", start: "2015-04-01", end: "2016-03-31" });
    expect(shifted.priceBucket).toBe(Date.parse("2016-01-01T00:00:00+09:00") / 1000);
    await page.keyboard.press("Escape");
    await expect(row(page, "debt_ratio").locator("details")).not.toHaveAttribute("open", "");
    await choosePeriod(page, false, "연");
    await expect(cell(page)).toHaveAttribute("aria-label", /연$/);
    const annual = (await data(app)).series.find((s) => s.metric === "revenue")!.points;
    const overlap = annual.findIndex((p) => p.reason === "period_overlap");
    expect(overlap).toBeGreaterThanOrEqual(0);
    await row(page, "revenue").locator("summary").click();
    await selectOption(row(page, "revenue").getByRole("combobox"), { index: overlap + 1 });
    await expect(row(page, "revenue").locator("details")).toContainText("원래 보고값 1,000 KRW · 합산하지 않음");
  });
});

test("DART 미설정 상태에서도 가격과 기술지표를 사용하고 재무 설정은 유지한다", async ({ page, app }) => {
  await seed(app);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "revenue")).toContainText("DART 연동 미설정");
  await expect(row(page, "ma")).toBeVisible();
  await choosePeriod(page, false, "일");
  await expect(row(page, "revenue")).toHaveCount(0);
  await choosePeriod(page, false, "연");
  await expect(row(page, "revenue")).toContainText("DART 연동 미설정");
});
