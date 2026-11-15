import type { Locator, Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { Quote } from "../src/api/generated/Quote";
import { allResult } from "./fixtures/screener";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test } from "./screener-harness";
import { openResultDetails, panel as screenerPanel, rowOf, rows as resultRows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ clockStart: "20261109100000" });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const LONG_NAME = "에스케이증권제14호기업인수목적아주아주길게이어지는이름";
const WATCHED = ["005930", "000660", "035420"];
const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const watchRow = (page: Page, code: string) => watchPanel(page).locator(`li[data-code="${code}"]`);
const quote = (symbol: string, price: number, change: number, changeRate: number): Quote => ({ symbol, price, change, changeRate, volume: 1000, t: 1794186000, source: "realtime" });

function seedCanvas(scenario: Scenario) {
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
  scenario.documents.saveWatchlists({ lists: lists.lists.map((list, i) => (i === 0 ? { ...list, symbols: WATCHED } : list)), revision: lists.revision + 1 });
  scenario.reply("/api/quotes", { body: [quote("005930", 71_200, 1_200, 1.71), quote("000660", 183_500, -2_500, -1.34), quote("035420", 210_000, 0, 0)] });
}

async function showBoth(scenario: Scenario, screener: { showResult(result: ReturnType<typeof allResult>): void }, page: Page) {
  seedCanvas(scenario);
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
  for (const name of names) expect([name.fontSize, name.fontWeight]).toEqual(["14px", "550"]);
  expect(names[0]!.color).toBe(names[1]!.color);

  const watchPrice = watchRow(page, "005930").locator("[data-main] > span").nth(1);
  const resultPrice = rowOf(page, rows[0]!.symbol).locator("td").nth(1).locator("span").first();
  const prices = [await look(watchPrice), await look(resultPrice)];
  expect(prices[0]!.fontSize).toBe("14px");
  expect(prices[1]!.fontSize).toBe("14px");
  expect(prices[0]!.width).toBe(prices[1]!.width);

  const watchRates = [watchRow(page, "005930"), watchRow(page, "000660"), watchRow(page, "035420")].map((r) => r.locator("[data-main] > span").nth(2));
  const resultRates = [rows[0]!, rows[1]!, rows[2]!].map((r) => rowOf(page, r.symbol).locator("td").nth(2).locator("span"));
  for (const [i, direction] of ["상승", "하락", "보합"].entries()) {
    const watched = await look(watchRates[i]!);
    const listed = await look(resultRates[i]!);
    expect({ direction, ...listed }).toEqual({ direction, ...watched });
    expect([watched.fontSize, watched.fontWeight]).toEqual(["12px", "550"]);
  }
  expect((await look(watchRates[0]!)).background).not.toBe((await look(watchRates[1]!)).background);
  expect((await look(watchRates[1]!)).background).not.toBe((await look(watchRates[2]!)).background);

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

test("고른 줄과 포인터가 올라간 줄의 바탕과 왼쪽 선이 두 목록에서 같다", async ({ scenario, screener, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await showBoth(scenario, screener, page);
  const chosenWatch = watchRow(page, "000660");
  await chosenWatch.locator("[data-main]").click();
  await expect(chosenWatch.locator("[data-main]")).toHaveAttribute("aria-current", "true");
  const watchChosenLook = { fill: (await look(chosenWatch)).background, edge: await edge(chosenWatch) };
  const chosenResult = rowOf(page, rows[1]!.symbol);
  await chosenResult.getByRole("button").click();
  await expect(chosenResult).toHaveAttribute("aria-selected", "true");
  await expect(chosenResult.getByRole("button")).toHaveAttribute("aria-current", "true");
  expect({ fill: (await look(chosenResult)).background, edge: await edge(chosenResult.locator("td").first()) }).toEqual(watchChosenLook);
  expect(watchChosenLook.edge.width).toBe("2px");
  expect(watchChosenLook.fill).not.toBe("rgba(0, 0, 0, 0)");
  const idleWatch = watchRow(page, "035420");
  const idleResult = rowOf(page, rows[2]!.symbol);
  expect(await edge(idleWatch)).toEqual(await edge(idleResult.locator("td").first()));
  await rowOf(page, rows[2]!.symbol).hover();
  const hoveredResult = (await look(rowOf(page, rows[2]!.symbol))).background;
  await watchRow(page, "035420").locator("[data-main]").hover();
  const hoveredWatch = (await look(watchRow(page, "035420").locator("[data-main]"))).background;
  expect(hoveredResult).toBe(hoveredWatch);
  expect(hoveredResult).toBe(watchChosenLook.fill);
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
  await expect(rowOf(page, rows[5]!.symbol)).toContainText("11-04");
  await expect(rowOf(page, rows[5]!.symbol).locator("td").nth(1)).toHaveAttribute("title", /최신 일봉 2026-11-04/);
});
