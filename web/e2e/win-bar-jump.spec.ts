import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Period } from "../src/api/generated/Period";
import { barInterval } from "../src/chart/crosshairSync";
import { formatBarTime, fromChartTime, toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { type Scenario, cell, chartOf, DEFAULT_LAYOUT_ID, dragTowardPast, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const SHOW = 50;
const SYMBOL = "005930";
const NO_TARGET = "같은 종목의 더 짧은 주기 차트가 없습니다";

interface Seeded {
  id: string;
  symbol: string;
  period: Period;
  compare?: string[];
}

function settings(compare: string[] = []) {
  return { v: 2, style: "candle", scale: "normal", indicators: [], compare, panels: [], visibleBars: SHOW };
}

function seed(scenario: Scenario, shown: Seeded[], hidden: Seeded[] = []) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const groups = shown.map((w, i) => ({ kind: "group", id: `g${i + 1}`, tabs: [w.id, ...(i === shown.length - 1 ? hidden.map((h) => h.id) : [])], active: w.id }));
  const stack = (nodes: object[]): object => (nodes.length === 1 ? nodes[0]! : { kind: "split", dir: "column", ratio: 1 / nodes.length, first: nodes[0], second: stack(nodes.slice(1)) });
  const root = groups.length === 1 ? groups[0] : { kind: "split", dir: "row", ratio: 0.5, first: groups[0], second: stack(groups.slice(1)) };
  scenario.documents.saveLayout({
    ...layout,
    windows: [...shown, ...hidden].map((w): LayoutWindow => ({ id: w.id, link: null, kind: "chart", symbol: w.symbol, venue: "combined", period: w.period, chartSettings: settings(w.compare) })),
    placement: { v: 1, dock: { root, floats: [] }, canvas: null },
    revision: layout.revision + 1,
  });
}

const DAILY: Seeded = { id: "cell-0", symbol: SYMBOL, period: "D" };
const MINUTE: Seeded = { id: "cell-1", symbol: SYMBOL, period: "5m" };

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function ready(page: Page, charts = 2) {
  await page.goto("/");
  for (let n = 1; n <= charts; n++) await expect(cell(page, n)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbes?.length ?? 0)).toBeGreaterThanOrEqual(charts);
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
}

const badge = (page: Page, n: number) => cell(page, n).getByRole("group", { name: "바로가기 모드" });
const jumpCalls = (scenario: Scenario) => scenario.requests.map((r) => new URL(r.url())).filter((url) => url.pathname === "/api/bars/jump").map((url) => url.searchParams);
const dailyBars = (scenario: Scenario): Bar[] => {
  const page = scenario.market.page({ symbol: SYMBOL, period: "D" });
  return page.current ? [...page.bars, page.current] : page.bars;
};
const dateBack = (scenario: Scenario, back: number) => formatBarTime(dailyBars(scenario).at(-1 - back)!.t, "D");
const lastBarOfDate = (scenario: Scenario, date: string, period: Period = "5m") => scenario.market.jumpPage({ symbol: SYMBOL, period, date }).bars.at(-1)!.t;

interface View { count: number; from: number; to: number; edgeIndex: number; edgeT: number | null; shown: number }

async function viewOf(page: Page, n: number): Promise<View> {
  return page.evaluate(({ n }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    if (!probe) throw new Error("차트 좌표가 없습니다");
    const count = Number(probe.chart.chartElement().closest("section")?.querySelector("[data-bar-count]")?.getAttribute("data-bar-count"));
    const range = probe.chart.timeScale().getVisibleLogicalRange();
    if (!range) throw new Error("보이는 범위가 없습니다");
    const edgeIndex = Math.min(Math.round(range.to), count - 1);
    const x = probe.chart.timeScale().logicalToCoordinate(edgeIndex as never);
    const edge = x === null ? null : probe.chart.timeScale().coordinateToTime(x);
    const time = typeof edge === "number" ? edge : null;
    return { count, from: range.from, to: range.to, edgeIndex, edgeT: time, shown: edgeIndex - Math.round(range.from) + 1 };
  }, { n }).then((v) => ({ ...v, edgeT: v.edgeT === null ? null : fromChartTime(v.edgeT as never) }));
}

async function scrollTo(page: Page, n: number, back: number) {
  await page.evaluate(({ n, back, show }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    const count = Number(probe?.chart.chartElement().closest("section")?.querySelector("[data-bar-count]")?.getAttribute("data-bar-count"));
    const index = count - 1 - back;
    probe?.chart.timeScale().setVisibleLogicalRange({ from: index - show + 1, to: index });
  }, { n, back, show: SHOW });
  await frames(page);
}

async function pointOnBar(page: Page, n: number, t: number) {
  const point = await page.evaluate(({ n, time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    const x = probe?.chart.timeScale().timeToCoordinate(time);
    const box = probe?.chart.chartElement().getBoundingClientRect();
    if (!probe || x === null || x === undefined || !box) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.4 };
  }, { n, time: toChartTime(t) });
  return point;
}

async function openJumpMenu(page: Page, scenario: Scenario, clickedBack: number) {
  const clicked = dailyBars(scenario);
  const bar = clicked.at(-1 - clickedBack)!;
  const point = await pointOnBar(page, 1, bar.t);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-09T10:00:00+09:00"));
  await page.addInitScript(installChartProbe);
});

test("일봉에서 우클릭하면 화면 가장 오른쪽 봉 날짜로 이름이 붙고, 고르면 분봉 차트가 그 날을 오른쪽 끝에 두고 바로가기 모드에 든다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const back = 8;
  const date = dateBack(scenario, back);
  await scrollTo(page, 1, back);
  const menu = await openJumpMenu(page, scenario, back + 12);
  await expect(menu.getByRole("menuitem", { name: `바로가기 · ${date}` })).toBeVisible();
  await menu.getByRole("menuitem", { name: `바로가기 · ${date}` }).click();

  await expect(badge(page, 2)).toContainText(`과거 보기 ${date}`);
  const expected = lastBarOfDate(scenario, date);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(expected));
  expect(jumpCalls(scenario).map((q) => ({ symbol: q.get("symbol"), period: q.get("period"), date: q.get("date"), before: q.get("before") }))).toEqual([{ symbol: SYMBOL, period: "5m", date, before: null }]);
  await expect.poll(async () => (await viewOf(page, 2)).edgeT).toBe(expected);
  expect((await viewOf(page, 2)).shown).toBe(SHOW);
  await expect(page.locator(".ui-toast")).toContainText(`5분 차트를 ${date} 기준으로 옮겼습니다`);
  const afterDate = Date.parse(`${date}T00:00:00+09:00`) / 1000 + 86400;
  expect(expected).toBeLessThan(afterDate);

  const before = (await viewOf(page, 2)).count;
  await dragTowardPast(page, chartOf(cell(page, 2)), async () => {
    expect(jumpCalls(scenario).some((q) => q.get("before") !== null)).toBe(true);
  });
  const older = jumpCalls(scenario).find((q) => q.get("before") !== null)!;
  expect(older.get("date")).toBe(date);
  await expect.poll(async () => (await viewOf(page, 2)).count).toBeGreaterThan(before);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(expected));
  expect(scenario.live.subscriptions().some((s) => s.symbol === SYMBOL && s.period === "5m")).toBe(false);
});

test("모드 중에는 실시간 프레임이 와도 봉이 늘지 않고, 뱃지를 닫으면 최신 페이지를 다시 받고 실시간 봉이 다시 붙는다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const latest = scenario.market.page({ symbol: SYMBOL, period: "5m" }).current!;
  const date = dateBack(scenario, 8);
  await scrollTo(page, 1, 8);
  await (await openJumpMenu(page, scenario, 20)).getByRole("menuitem", { name: /^바로가기 · / }).click();
  await expect(badge(page, 2)).toContainText(`과거 보기 ${date}`);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(lastBarOfDate(scenario, date)));
  const inMode = (await viewOf(page, 2)).count;

  const delivered = scenario.live.bar(SYMBOL, { ...latest, t: latest.t + 300 });
  expect(delivered).toBe(1);
  await frames(page);
  expect((await viewOf(page, 2)).count).toBe(inMode);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(lastBarOfDate(scenario, date)));

  const normalBefore = scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/bars" && new URL(r.url()).searchParams.get("period") === "5m").length;
  await badge(page, 2).getByRole("button", { name: "바로가기 끝내기" }).click();
  await expect(badge(page, 2)).toBeHidden();
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(latest.t));
  expect(scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/bars" && new URL(r.url()).searchParams.get("period") === "5m").length).toBeGreaterThan(normalBefore);
  await expect.poll(() => scenario.live.subscriptions().some((s) => s.symbol === SYMBOL && s.period === "5m")).toBe(true);
  scenario.live.bar(SYMBOL, { ...latest, t: latest.t + 300 }, "confirmed");
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(latest.t + 300));
});

test("수정주가를 반영하지 못한 날짜가 있으면 뱃지가 경고하고 날짜를 title에 둔다", async ({ page, scenario }) => {
  scenario.on("/api/bars/jump", (request) => {
    const q = new URL(request.url()).searchParams;
    const page = scenario.market.jumpPage({ symbol: q.get("symbol")!, period: q.get("period") as Period, date: q.get("date")!, before: q.has("before") ? Number(q.get("before")) : null });
    return { body: { ...page, unadjustedDays: ["2026-10-28"] } };
  });
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  await scrollTo(page, 1, 8);
  await (await openJumpMenu(page, scenario, 20)).getByRole("menuitem", { name: /^바로가기 · / }).click();
  await expect(badge(page, 2)).toContainText("일부 날짜 수정주가 미반영");
  await expect(badge(page, 2).getByText("일부 날짜 수정주가 미반영")).toHaveAttribute("title", /2026-10-28/);
});

test("비교 종목이 있는 분봉 차트는 모드 중 비교 선이 숨고 뱃지가 알리며, 끝내면 비교 선이 돌아온다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, { ...MINUTE, compare: ["000660"] }]);
  await ready(page);
  const rows = cell(page, 2).locator("[data-compare-row]");
  await expect(rows).toHaveCount(1);
  await scrollTo(page, 1, 8);
  await (await openJumpMenu(page, scenario, 20)).getByRole("menuitem", { name: /^바로가기 · / }).click();
  await expect(badge(page, 2)).toContainText("비교 숨김");
  await expect(rows).toHaveCount(0);
  await badge(page, 2).getByRole("button", { name: "바로가기 끝내기" }).click();
  await expect(badge(page, 2)).toBeHidden();
  await expect(rows).toHaveCount(1);
});

test("Alt+G는 포인터가 다른 봉 위에 있어도 차트 밖에 있어도 화면 오른쪽 끝 봉 날짜로 간다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const date = dateBack(scenario, 8);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  const point = await pointOnBar(page, 1, dailyBars(scenario).at(-1 - 20)!.t);
  await page.mouse.move(point.x, point.y);
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText(`과거 보기 ${date}`);
  expect(jumpCalls(scenario).map((q) => q.get("date"))).toEqual([date]);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(lastBarOfDate(scenario, date)));

  await badge(page, 2).getByRole("button", { name: "바로가기 끝내기" }).click();
  await expect(badge(page, 2)).toBeHidden();
  await cell(page, 1).focus();
  await page.mouse.move(2, 2);
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText(`과거 보기 ${date}`);
  expect(jumpCalls(scenario).map((q) => q.get("date"))).toEqual([date, date]);
});

test("Alt+G는 처음 화면에서 마지막 봉, 곧 오늘이라 모드 없이 화면만 옮기고 /api/bars/jump를 부르지 않는다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const target = chartOf(cell(page, 2));
  await scrollTo(page, 2, 60);
  expect((await viewOf(page, 2)).edgeT).not.toBe(Number(await target.getAttribute("data-last-bar-t")));
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect.poll(async () => (await viewOf(page, 2)).edgeT).toBe(Number(await target.getAttribute("data-last-bar-t")));
  await expect(page.locator(".ui-toast")).toContainText("5분 차트를 2026-11-09 기준으로 옮겼습니다");
  await expect(badge(page, 2)).toBeHidden();
  expect(jumpCalls(scenario)).toEqual([]);
  expect((await viewOf(page, 2)).shown).toBe(SHOW);
});

test("분봉 차트가 이미 가진 날짜(어제 등)로 가면 /api/bars/jump를 부르지 않고 화면만 옮긴다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const date = dateBack(scenario, 1);
  await scrollTo(page, 1, 1);
  await (await openJumpMenu(page, scenario, 6)).getByRole("menuitem", { name: `바로가기 · ${date}` }).click();
  const expected = lastBarOfDate(scenario, date);
  await expect.poll(async () => (await viewOf(page, 2)).edgeT).toBe(expected);
  expect(jumpCalls(scenario)).toEqual([]);
  await expect(badge(page, 2)).toBeHidden();
  await expect(page.locator(".ui-toast")).toContainText(`5분 차트를 ${date} 기준으로 옮겼습니다`);

  const view = await viewOf(page, 2);
  expect(view.shown).toBe(SHOW);
  expect(view.count - 1).toBeGreaterThan(view.edgeIndex);
  expect(Math.abs(view.to - view.edgeIndex)).toBeLessThan(0.01);
  const hidden = await page.evaluate(({ n }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith(`칸 ${n}: `));
    const next = probe?.chart.timeScale().getVisibleLogicalRange();
    return next ? Math.floor(next.to + 0.5 + 1e-6) : null;
  }, { n: 2 });
  expect(hidden).toBe(view.edgeIndex);

  const box = (await chartOf(cell(page, 2)).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await viewOf(page, 2)).to).toBeGreaterThan(view.to + 3);
  expect((await viewOf(page, 2)).edgeT).toBeGreaterThan(expected);
});

test("다른 종목의 분봉 차트는 움직이지 않는다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE, { id: "cell-2", symbol: "000660", period: "5m" }]);
  await ready(page);
  const date = dateBack(scenario, 8);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText(`과거 보기 ${date}`);
  expect(jumpCalls(scenario).map((q) => q.get("symbol"))).toEqual([SYMBOL]);
  await expect(chartOf(cell(page, 3))).toHaveAttribute("data-last-bar-t", String(scenario.market.page({ symbol: "000660", period: "5m" }).current!.t));
});

test("같은 종목의 더 짧은 주기 차트가 없으면 알림만 보이고 아무 요청도 나가지 않는다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, { id: "cell-1", symbol: "000660", period: "5m" }]);
  await ready(page);
  const requests = scenario.requests.length;
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(page.locator(".ui-toast")).toContainText(NO_TARGET);
  expect(scenario.requests.length).toBe(requests);
});

test("빈 첫 페이지면 모드에 들지 않고 키움이 주지 않는다는 알림을 보인다", async ({ page, scenario }) => {
  scenario.on("/api/bars/jump", (request) => {
    const q = new URL(request.url()).searchParams;
    return { body: { symbol: SYMBOL, venue: "combined", period: q.get("period"), date: q.get("date"), bars: [], nextBefore: null, unadjustedDays: [] } };
  });
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const date = dateBack(scenario, 8);
  const last = Number(await chartOf(cell(page, 2)).getAttribute("data-last-bar-t"));
  await scrollTo(page, 1, 8);
  await (await openJumpMenu(page, scenario, 20)).getByRole("menuitem", { name: /^바로가기 · / }).click();
  await expect(page.locator(".ui-toast")).toContainText(`${date} 분봉을 키움이 주지 않습니다`);
  await expect(badge(page, 2)).toBeHidden();
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(last));
  await expect.poll(() => scenario.live.subscriptions().some((s) => s.symbol === SYMBOL && s.period === "5m")).toBe(true);
});

test("받는 동안 대상 차트의 주기를 바꾸면 바꾼 주기의 차트에 뱃지가 없고 옛 응답으로 움직이지 않는다", async ({ page, scenario }) => {
  const held = scenario.hold("/api/bars/jump");
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const date = dateBack(scenario, 8);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await held.received;
  await expect(badge(page, 2)).toContainText("받는 중");
  await cell(page, 2).focus();
  await page.keyboard.press("1");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /1분$/);
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect(badge(page, 2)).toBeHidden();
  const settled = await chartOf(cell(page, 2)).getAttribute("data-last-bar-t");
  held.reply({ body: scenario.market.jumpPage({ symbol: SYMBOL, period: "5m", date }) });
  await frames(page);
  await expect(badge(page, 2)).toBeHidden();
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", settled!);
});

test("고르지 않은 탭에 숨은 분봉 차트도 모드에 들고, 그 탭을 고르면 그 날이 오른쪽 끝이고 뱃지가 보인다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, { id: "cell-2", symbol: "000810", period: "D" }], [MINUTE]);
  await ready(page, 2);
  const date = dateBack(scenario, 8);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect.poll(() => jumpCalls(scenario).map((q) => q.get("date"))).toEqual([date]);
  await page.getByRole("tab", { name: /5분/ }).click();
  await expect(cell(page, 3)).toBeVisible();
  await expect(badge(page, 3)).toContainText(`과거 보기 ${date}`);
  const expected = lastBarOfDate(scenario, date);
  await expect(chartOf(cell(page, 3))).toHaveAttribute("data-last-bar-t", String(expected));
  await expect.poll(async () => (await viewOf(page, 3)).edgeT).toBe(expected);
  expect((await viewOf(page, 3)).shown).toBe(SHOW);
});

test("새로고침하면 모드가 풀린 평소 화면이다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toBeVisible();
  await page.reload();
  await ready(page);
  await expect(badge(page, 2)).toBeHidden();
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(scenario.market.page({ symbol: SYMBOL, period: "5m" }).current!.t));
});

test("주봉에서 가면 일봉 차트가 그 주 끝까지 과거 봉을 이어 받아 오른쪽 끝에 두고, 모드에는 들지 않는다", async ({ page, scenario }) => {
  seed(scenario, [{ id: "cell-0", symbol: SYMBOL, period: "W" }, { id: "cell-1", symbol: SYMBOL, period: "D" }]);
  await ready(page);
  const weeks = scenario.market.page({ symbol: SYMBOL, period: "W" });
  const back = 130;
  const week = [...weeks.bars, weeks.current!].at(-1 - back)!;
  const interval = barInterval(week.t, "W");
  const all = scenario.market.page({ symbol: SYMBOL, period: "D", limit: 6000 });
  const expected = [...all.bars].filter((bar) => bar.t < interval.end).at(-1)!.t;
  const held = Number(await chartOf(cell(page, 2)).getAttribute("data-bar-count"));
  expect(Number(await chartOf(cell(page, 2)).getAttribute("data-first-bar-t"))).toBeGreaterThan(expected);
  await scrollTo(page, 1, back);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(page.locator(".ui-toast")).toContainText("일 차트를");
  await expect.poll(async () => (await viewOf(page, 2)).edgeT).toBe(expected);
  expect((await viewOf(page, 2)).count).toBeGreaterThan(held);
  expect((await viewOf(page, 2)).shown).toBe(SHOW);
  await expect(badge(page, 2)).toBeHidden();
  expect(jumpCalls(scenario)).toEqual([]);
  expect(scenario.requests.filter((r) => new URL(r.url()).searchParams.get("period") === "D" && new URL(r.url()).searchParams.has("before")).length).toBeGreaterThan(0);
});

test("모드 중 더 이른 날짜로 바로가기하면 새 기준일로 다시 받아 뱃지와 화면이 그 날짜가 된다", async ({ page, scenario }) => {
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  const first = dateBack(scenario, 8);
  const earlier = dateBack(scenario, 9);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText(`과거 보기 ${first}`);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(lastBarOfDate(scenario, first)));

  await scrollTo(page, 1, 9);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText(`과거 보기 ${earlier}`);
  expect(jumpCalls(scenario).map((q) => q.get("date"))).toEqual([first, earlier]);
  const expected = lastBarOfDate(scenario, earlier);
  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(expected));
  await expect.poll(async () => (await viewOf(page, 2)).edgeT).toBe(expected);
  expect((await viewOf(page, 2)).shown).toBe(SHOW);
});

test("모드 중 새 기준일을 받는 동안 뱃지에 앞 기준일의 수정주가 미반영 날짜가 없다", async ({ page, scenario }) => {
  scenario.on("/api/bars/jump", (request) => {
    const q = new URL(request.url()).searchParams;
    const jump = scenario.market.jumpPage({ symbol: q.get("symbol")!, period: q.get("period") as Period, date: q.get("date")!, before: q.has("before") ? Number(q.get("before")) : null });
    return { body: { ...jump, unadjustedDays: ["2026-10-28"] } };
  });
  seed(scenario, [DAILY, MINUTE]);
  await ready(page);
  await scrollTo(page, 1, 8);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText("일부 날짜 수정주가 미반영");
  scenario.hold("/api/bars/jump");
  await scrollTo(page, 1, 9);
  await cell(page, 1).focus();
  await page.keyboard.press("Alt+KeyG");
  await expect(badge(page, 2)).toContainText("받는 중");
  await expect(badge(page, 2)).not.toContainText("수정주가 미반영");
});
