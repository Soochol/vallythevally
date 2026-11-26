import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Quote } from "../src/api/generated/Quote";
import { allResult } from "./fixtures/screener";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test } from "./screener-harness";
import { openResultDetails, panel as screenerPanel, rowOf, rows as resultRows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";
import { DENSITY_STORAGE_KEY } from "../src/persist/density";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "regular"), DENSITY_STORAGE_KEY);
});

test.use({ clockStart: "20261109100000" });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const LONG_NAME = "에스케이증권제14호기업인수목적아주아주길게이어지는이름";
const WATCHED = ["005930", "000660", "035420"];
const COLUMN_GAP = 8;
const RATE_WIDTH = 64;
const SCREENER_CELL_PAD_LEFT = 4;
const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const watchRow = (page: Page, code: string) => watchPanel(page).locator(`li[data-code="${code}"]`);
const quote = (symbol: string, price: number, change: number, changeRate: number): Quote => ({ symbol, price, change, changeRate, volume: 1000, t: 1794186000, source: "realtime", venue: "combined" });

function seedCanvas(scenario: Scenario, watched: readonly string[]) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: null, kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    { id: "watchlist", link: null, kind: "watchlist" },
    { id: "screener", link: null, kind: "screener" },
  ];
  const canvas = { rects: { "cell-0": { x: 0.02, y: 0.66, w: 0.3, h: 0.32 }, watchlist: { x: 0.02, y: 0.02, w: 0.3, h: 0.6 }, screener: { x: 0.36, y: 0.02, w: 0.3, h: 0.9 } }, order: ["cell-0", "watchlist", "screener"] };
  scenario.documents.saveLayout({ ...layout, windows, placement: { v: 1, dock: null, canvas }, revision: layout.revision + 1 });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), layoutMode: "canvas" });
  scenario.documents.saveScreens({ revision: 1, screens: [{ id: "all", name: "모든 종목", markets: [], exclude: [], conditions: [] }] });
  const lists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: [...watched] } : list)), revision: lists.revision + 1 });
  scenario.reply("/api/quotes", { body: [quote("005930", 71_200, 1_200, 1.71), quote("000660", 183_500, -2_500, -1.34), quote("035420", 210_000, 0, 0)] });
}

async function showBoth(scenario: Scenario, screener: { showResult(result: ReturnType<typeof allResult>): void }, page: Page, watched: readonly string[] = WATCHED) {
  seedCanvas(scenario, watched);
  const result = allResult();
  const [up, down, flat, long, provisional, old] = result.rows;
  result.rows = [
    { ...up!, changeRate: 3.21 },
    { ...down!, changeRate: -2.5 },
    { ...flat!, changeRate: 0 },
    { ...long!, name: LONG_NAME },
    { ...provisional!, provisional: true },
    { ...old!, latestBarDate: "2026-11-04" },
  ];
  screener.showResult(result);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(screenerPanel(page)).toBeVisible();
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(resultRows(page)).toHaveCount(6);
  await openResultDetails(page);
  return result.rows;
}

const look = (target: Locator) => target.evaluate((el) => {
  const style = getComputedStyle(el);
  return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, background: style.backgroundColor, radius: style.borderRadius, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
});
const edge = (target: Locator) => target.evaluate((el) => {
  const style = getComputedStyle(el);
  return { width: style.borderLeftWidth, color: style.borderLeftColor };
});
const rightGap = async (target: Locator, container: Locator) => {
  const right = await container.evaluate((el) => el.getBoundingClientRect().right);
  return target.evaluate((el, edgeRight) => edgeRight - el.getBoundingClientRect().right, right);
};

test("두 목록의 줄은 같은 글자 크기·굵기·배지·높이·열 폭을 쓴다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  const watchedName = watchRow(page, "005930").locator("b");
  const resultName = rowOf(page, rows[0]!.symbol).locator("b");
  const names = [await look(watchedName), await look(resultName)];
  for (const name of names) expect([name.fontSize, name.fontWeight]).toEqual(["13px", "600"]);
  expect(names[0]!.color).toBe(names[1]!.color);

  const watchPrice = watchRow(page, "005930").locator("[data-main] > span").nth(1);
  const resultPrice = rowOf(page, rows[0]!.symbol).locator("td").nth(1).locator("span").first();
  const prices = [await look(watchPrice), await look(resultPrice)];
  expect(prices[0]!.fontSize).toBe("13px");
  expect(prices[1]!.fontSize).toBe("13px");
  expect(prices[0]!.width + COLUMN_GAP).toBe((await look(rowOf(page, rows[0]!.symbol).locator("td").nth(1))).width);

  const watchRates = [watchRow(page, "005930"), watchRow(page, "000660"), watchRow(page, "035420")].map((r) => r.locator("[data-main] > span").nth(2));
  const resultRates = [rows[0]!, rows[1]!, rows[2]!].map((r) => rowOf(page, r.symbol).locator("td").nth(2).locator("span").first());
  for (const [i, direction] of ["상승", "하락", "보합"].entries()) {
    const watched = await look(watchRates[i]!);
    const { width: listedWidth, ...listed } = await look(resultRates[i]!);
    const { width: watchedWidth, ...same } = watched;
    expect({ direction, ...listed }).toEqual({ direction, ...same });
    expect([watched.fontSize, watched.fontWeight]).toEqual(["11px", direction === "보합" ? "500" : "600"]);
    expect(watchedWidth).toBe(RATE_WIDTH);
    expect(listedWidth).toBe(RATE_WIDTH + COLUMN_GAP - SCREENER_CELL_PAD_LEFT);
  }
  expect((await look(watchRates[0]!)).color).not.toBe((await look(watchRates[1]!)).color);
  expect((await look(watchRates[1]!)).color).not.toBe((await look(watchRates[2]!)).color);
  expect((await look(watchRates[0]!)).color).not.toBe((await look(watchRates[2]!)).color);

  for (const row of [watchRow(page, "005930"), watchRow(page, "000660"), rowOf(page, rows[0]!.symbol), rowOf(page, rows[3]!.symbol), rowOf(page, rows[4]!.symbol), rowOf(page, rows[5]!.symbol)]) {
    expect((await look(row)).height).toBe(34);
  }
  const watchContainer = watchRow(page, "005930");
  const resultContainer = rowOf(page, rows[0]!.symbol);
  expect(await rightGap(watchRates[0]!, watchContainer)).toBe(await rightGap(resultRates[0]!, resultContainer));
  expect(await rightGap(watchPrice, watchContainer) - await rightGap(watchRates[0]!, watchContainer)).toBe(await rightGap(resultPrice, resultContainer) - await rightGap(resultRates[0]!, resultContainer));

  const watchHead = watchPanel(page).locator("div[aria-hidden=true]").first();
  const resultHead = screenerPanel(page).getByRole("columnheader").first();
  const heads = [await look(watchHead), await look(resultHead)];
  expect(heads.map((h) => h.fontSize)).toEqual(["11px", "11px"]);
  expect(await resultHead.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
  expect(await resultHead.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
  expect(await resultContainer.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
});

const tokenColor = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}, token);
const nameOffset = (row: Locator) => row.evaluate((el) => el.querySelector("b")!.getBoundingClientRect().left - el.getBoundingClientRect().left);

test("고른 줄은 --accent-soft 바탕, 포인터를 올린 줄은 --hover 바탕이고 왼쪽 선이 없다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  const accentSoft = await tokenColor(page, "--accent-soft");
  const hover = await tokenColor(page, "--hover");
  const chosenWatch = watchRow(page, "000660");
  await chosenWatch.locator("[data-main]").click();
  await expect(chosenWatch.locator("[data-main]")).toHaveAttribute("aria-current", "true");
  await page.mouse.move(0, 0);
  expect((await look(chosenWatch)).background).toBe(accentSoft);
  expect((await edge(chosenWatch)).width).toBe("0px");
  await chosenWatch.locator("[data-main]").hover();
  expect((await look(chosenWatch)).background).toBe(accentSoft);
  const chosenResult = rowOf(page, rows[1]!.symbol);
  await chosenResult.getByRole("button").click();
  await expect(chosenResult).toHaveAttribute("aria-selected", "true");
  await expect(chosenResult.getByRole("button")).toHaveAttribute("aria-current", "true");
  await page.mouse.move(0, 0);
  expect((await look(chosenResult)).background).toBe(accentSoft);
  expect((await edge(chosenResult.locator("td").first())).width).toBe("0px");
  const idleWatch = watchRow(page, "035420");
  const idleResult = rowOf(page, rows[2]!.symbol);
  expect((await edge(idleWatch)).width).toBe("0px");
  expect((await edge(idleResult.locator("td").first())).width).toBe("0px");
  const idle = (await look(idleWatch)).background;
  expect((await look(idleResult)).background).toBe(idle);
  await idleResult.hover();
  expect((await look(idleResult)).background).toBe(hover);
  await idleWatch.locator("[data-main]").hover();
  expect((await look(idleWatch)).background).toBe(hover);
  expect(hover).not.toBe(idle);
  expect(hover).not.toBe(accentSoft);
  await chosenResult.hover();
  expect((await look(chosenResult)).background).toBe(accentSoft);
  expect(await nameOffset(idleWatch)).toBe(12);
  expect(await nameOffset(idleResult)).toBe(12);
});

test("두 목록의 줄에는 종목코드 글자가 없고 풍선말에 이름과 코드가 있다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  for (const code of WATCHED) await expect(watchRow(page, code).getByText(code)).toHaveCount(0);
  await expect(watchRow(page, "005930").locator("b")).toHaveAttribute("title", "삼성전자 005930");
  for (const row of rows) {
    await expect(rowOf(page, row.symbol).getByText(row.symbol)).toHaveCount(0);
    await expect(rowOf(page, row.symbol).locator("b")).toHaveAttribute("title", `${row.name} ${row.symbol}`);
  }
  const visible = await watchPanel(page).locator("li").allInnerTexts();
  for (const text of visible) expect(text).not.toMatch(/\b\d{6}\b|지수/);
});

test("종목 정보를 찾을 수 없는 관심종목은 이름 자리에 코드를 적고 풍선말에는 코드를 한 번만 적는다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  scenario.reply("/api/symbols/999999", { status: 404, body: { error: { code: "unknown_symbol", message: "없는 종목입니다" } } });
  await showBoth(scenario, screener, page, [...WATCHED, "999999"]);
  const unknown = watchRow(page, "999999");
  await expect(unknown.locator("b")).toHaveText("999999");
  await expect(unknown.locator("b")).toHaveAttribute("title", "999999");
  await expect(unknown).toContainText("찾을 수 없음");
  expect((await look(unknown)).height).toBe(34);
});

test("긴 이름은 줄 안에서 말줄임표로 잘리고 숫자 열을 밀지 않는다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  const longRow = rowOf(page, rows[3]!.symbol);
  const shortRow = rowOf(page, rows[0]!.symbol);
  const clipped = longRow.locator("b");
  expect(await clipped.evaluate((el) => [getComputedStyle(el).textOverflow, getComputedStyle(el).overflow, el.scrollWidth > el.clientWidth])).toEqual(["ellipsis", "hidden", true]);
  const columns = async (row: Locator) => row.locator("td").evaluateAll((cells) => cells.slice(1).map((c) => { const box = c.getBoundingClientRect(); return [box.left, box.right]; }));
  expect(await columns(longRow)).toEqual(await columns(shortRow));
  expect((await look(longRow)).height).toBe(34);
});

test("스크리너의 정렬 표시, 잠정 별표, 옛 일봉 날짜가 그대로 보인다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  await screenerPanel(page).getByRole("button", { name: "현재가 순으로 정렬", exact: true }).click();
  await expect(screenerPanel(page).getByRole("columnheader", { name: "현재가 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", /ascending|descending/);
  await expect(screenerPanel(page).getByRole("columnheader", { name: "종목 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", "none");
  await expect(rowOf(page, rows[4]!.symbol).getByLabel("잠정", { exact: true })).toBeVisible();
  await expect(rowOf(page, rows[5]!.symbol).getByRole("img", { name: "최신 일봉 11-04", exact: true })).toBeVisible();
  await expect(rowOf(page, rows[5]!.symbol).locator("td").nth(1)).toHaveAttribute("title", /최신 일봉 2026-11-04/);
});

const rateCell = (page: Page, code: string) => watchRow(page, code).locator('[data-cell="changeRate"]');
const priceCell = (page: Page, code: string) => watchRow(page, code).locator('[data-cell="price"]');
const narrowPanel = (page: Page, width: number) => watchPanel(page).evaluate((el, w) => { el.style.flex = "none"; el.style.width = `${w}px`; }, width);

test("등락률 배지는 64px 폭이고 현재가 열과 8px 떨어져 있다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await showBoth(scenario, screener, page);
  const price = (await priceCell(page, "005930").boundingBox())!;
  const rate = (await rateCell(page, "005930").boundingBox())!;
  expect(rate.width).toBe(RATE_WIDTH);
  expect(rate.x - (price.x + price.width)).toBe(COLUMN_GAP);
});

test("창 폭 242px에서는 현재가만 남고 그 글자가 상승·하락 방향 색이다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await showBoth(scenario, screener, page);
  await narrowPanel(page, 242);
  await expect(watchRow(page, "005930").locator("[data-cell]")).toHaveCount(1);
  await expect(priceCell(page, "005930")).toBeVisible();
  const color = (code: string) => priceCell(page, code).locator("> span").evaluate((el) => getComputedStyle(el).color);
  expect(await color("005930")).toBe(await tokenColor(page, "--up"));
  expect(await color("000660")).toBe(await tokenColor(page, "--down"));
  expect(await color("035420")).toBe(await tokenColor(page, "--text-2"));
});

test("창 폭 358px에서 열 넷을 켜면 목록 메뉴가 거래량만 창이 좁아 숨겼다고 알린다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await showBoth(scenario, screener, page);
  await narrowPanel(page, 358);
  await watchPanel(page).getByRole("button", { name: /^관심종목 목록:/ }).click();
  const menu = page.getByRole("menu", { name: "관심종목 목록" });
  await menu.getByRole("menuitemcheckbox", { name: "등락", exact: true }).click();
  await menu.getByRole("menuitemcheckbox", { name: "거래량", exact: true }).click();
  const item = (name: string) => menu.getByRole("menuitemcheckbox", { name: new RegExp(`^${name}`) });
  await expect(item("거래량")).toContainText("창이 좁아 숨김");
  for (const shown of ["현재가", "등락률", "등락"]) await expect(menu.getByRole("menuitemcheckbox", { name: shown, exact: true })).not.toContainText("창이 좁아 숨김");
  await page.keyboard.press("Escape");
  await expect(watchRow(page, "005930").locator("[data-cell]")).toHaveCount(3);
});

const contrastOfBadge = (badge: Locator) => badge.evaluate((el) => {
  const rgba = (css: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  };
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) layers.unshift(getComputedStyle(node).backgroundColor);
  let back = rgba(getComputedStyle(document.body).backgroundColor);
  for (const layer of layers) {
    const top = rgba(layer);
    back = { r: top.r * top.a + back.r * (1 - top.a), g: top.g * top.a + back.g * (1 - top.a), b: top.b * top.a + back.b * (1 - top.a), a: 1 };
  }
  const front = rgba(getComputedStyle(el).color);
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const [lr, lg, lb] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  };
  const [light, dark] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
});

test("보는 종목 줄 위의 상승·하락 배지는 글자와 바탕의 대비가 4.5:1 이상이다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await showBoth(scenario, screener, page);
  const accentSoft = await tokenColor(page, "--accent-soft");
  for (const code of ["005930", "000660"]) {
    await watchRow(page, code).locator("[data-main]").click();
    await expect(watchRow(page, code).locator("[data-main]")).toHaveAttribute("aria-current", "true");
    await page.mouse.move(0, 0);
    expect((await look(watchRow(page, code))).background).toBe(accentSoft);
    expect(await contrastOfBadge(rateCell(page, code))).toBeGreaterThanOrEqual(4.5);
  }
});

test("상승 배지에는 ▲, 하락 배지에는 ▼가 있고 보합 배지에는 방향 표시가 없다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  await expect(rateCell(page, "005930")).toContainText("▲1.71%");
  await expect(rateCell(page, "000660")).toContainText("▼1.34%");
  await expect(rateCell(page, "035420")).not.toContainText(/[▲▼]/);
  await expect(rowOf(page, rows[0]!.symbol).locator("td").nth(2)).toContainText("▲3.21%");
  await expect(rowOf(page, rows[1]!.symbol).locator("td").nth(2)).toContainText("▼2.50%");
});
