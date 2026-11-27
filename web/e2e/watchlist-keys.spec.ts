import type { Page } from "@playwright/test";
import type { WatchGroup } from "../src/api/generated/WatchGroup";
import { DENSITY_STORAGE_KEY } from "../src/persist/density";
import { allResult } from "./fixtures/screener";
import { cell, expect, type Scenario, test } from "./screener-harness";
import { openScreener, rows as resultRows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";
import { windowTab } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "regular"), DENSITY_STORAGE_KEY);
});

const THREE = ["005930", "086520", "005935"];
const FOUR = [...THREE, "000660"];

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const main = (page: Page, code: string) => row(page, code).locator("[data-main]");
const codes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((items) => items.map((el) => el.getAttribute("data-code")));
const groupHead = (page: Page, name: string) => panel(page).getByRole("button", { name: new RegExp(`^${name} \\d+종목$`) });
const pressHead = (page: Page, count: number) => panel(page).getByText(`${count}종목`, { exact: true }).first().click();
const showsSymbol = (page: Page, name: string) => expect(cell(page)).toHaveAttribute("aria-label", new RegExp(`^칸 1: ${name} `));

function seed(scenario: Scenario, symbols: string[], groups: WatchGroup[] = []) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: layout.windows.map((w) => (w.kind === "chart" || w.kind === "watchlist" || w.kind === "screener" ? { ...w, link: "a" } : w)),
  });
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols, groups }] });
}

async function open(page: Page, symbol = "005930") {
  await page.goto(`/?symbol=${symbol}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "086520").first()).toContainText("에코프로");
  await expect(row(page, "005935").first()).toContainText("삼성전자우");
}

test("관심종목 머리를 누른 뒤 방향키는 보는 종목을 위아래로 바꾸고 양 끝에서 멈춘다", async ({ scenario, page }) => {
  seed(scenario, THREE);
  await open(page);
  await pressHead(page, 3);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
  await page.keyboard.press("ArrowUp");
  await showsSymbol(page, "에코프로");
  expect(await codes(page)).toEqual(THREE);
  expect(scenario.documents.watchlists().revision).toBe(100);
});

test("보는 종목이 목록에 없으면 아래는 첫 줄 위는 끝 줄로 간다", async ({ scenario, page }) => {
  seed(scenario, THREE);
  await open(page, "000660");
  await pressHead(page, 3);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자");
  await open(page, "000660");
  await showsSymbol(page, "SK하이닉스");
  await pressHead(page, 3);
  await page.keyboard.press("ArrowUp");
  await showsSymbol(page, "삼성전자우");
});

test("접힌 그룹을 건너뛰고 같은 종목이 든 두 줄을 차례로 지난다", async ({ scenario, page }) => {
  seed(scenario, FOUR, [{ id: "g1", name: "첫째", symbols: ["005930", "086520"] }, { id: "g2", name: "둘째", symbols: ["086520", "005935"] }]);
  await open(page);
  await main(page, "005930").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
  await groupHead(page, "둘째").click();
  await expect(row(page, "005935")).toHaveCount(0);
  await main(page, "005930").click();
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "SK하이닉스");
});

test("누르고 있는 동안 줄 표시만 따라가고 떼면 그 종목으로 바꾼다", async ({ scenario, page }) => {
  const barSymbols: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/bars") barSymbols.push(url.searchParams.get("symbol"));
  });
  seed(scenario, FOUR);
  await page.clock.install();
  await open(page);
  await expect(row(page, "000660")).toContainText("SK하이닉스");
  await pressHead(page, 4);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.down("ArrowDown");
  await showsSymbol(page, "에코프로");
  await page.keyboard.down("ArrowDown");
  await page.keyboard.down("ArrowDown");
  await expect(main(page, "000660")).toHaveAttribute("aria-current", "true");
  await expect(panel(page).locator("[data-main][aria-current=true]")).toHaveCount(1);
  await showsSymbol(page, "에코프로");
  await page.keyboard.up("ArrowDown");
  await showsSymbol(page, "SK하이닉스");
  await page.clock.resume();
  await expect.poll(() => barSymbols).toContain("000660");
  expect(barSymbols).not.toContain("005935");
});

test("누르고 있다가 0.15초 멈추면 떼지 않아도 그 종목으로 바꾼다", async ({ scenario, page }) => {
  seed(scenario, FOUR);
  await page.clock.install();
  await open(page);
  await pressHead(page, 4);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.keyboard.down("ArrowDown");
  await page.keyboard.down("ArrowDown");
  await expect(main(page, "005935")).toHaveAttribute("aria-current", "true");
  await page.clock.runFor(140);
  await showsSymbol(page, "에코프로");
  await page.clock.runFor(20);
  await showsSymbol(page, "삼성전자우");
  await page.keyboard.up("ArrowDown");
});

test("다른 창을 누르면 방향키가 관심종목을 바꾸지 않고 관심종목 탭을 누르면 다시 바꾼다", async ({ scenario, page }) => {
  seed(scenario, FOUR);
  await open(page);
  await pressHead(page, 4);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await cell(page).click();
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await windowTab(page, "관심종목").click();
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
});

test("스크리너 결과가 있어도 관심종목을 누른 뒤 방향키는 관심종목을 따른다", async ({ scenario, screener, page }) => {
  const result = allResult();
  seed(scenario, THREE);
  scenario.documents.saveScreens({ revision: 1, screens: [{ id: "all", name: "모든 종목", markets: [], exclude: [], conditions: [] }] });
  screener.showResult(result);
  const layout = scenario.documents.layout();
  const chart = layout.windows.find((w) => w.kind === "chart")!.id;
  const watch = layout.windows.find((w) => w.kind === "watchlist")!.id;
  const screen = layout.windows.find((w) => w.kind === "screener")!.id;
  const others = layout.windows.map((w) => w.id).filter((id) => id !== chart && id !== watch && id !== screen);
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, placement: { v: 1, canvas: null, dock: { floats: [], root: {
    kind: "split", dir: "row", ratio: 0.4,
    first: { kind: "group", id: "g1", tabs: [chart, ...others], active: chart },
    second: { kind: "split", dir: "row", ratio: 0.5,
      first: { kind: "group", id: "g2", tabs: [watch], active: watch },
      second: { kind: "group", id: "g3", tabs: [screen], active: screen } },
  } } } });
  await open(page);
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(resultRows(page)).toHaveCount(result.rows.length);
  await pressHead(page, 3);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
});

test("방향키로 고른 줄은 초점 테두리 없이 바탕만 있고 Alt 방향키가 그 줄의 순서를 바꾼다", async ({ scenario, page }) => {
  seed(scenario, FOUR);
  await open(page);
  await main(page, "005930").click();
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");
  await expect(main(page, "086520")).toHaveAttribute("aria-current", "true");
  await expect(main(page, "086520")).toBeFocused();
  await expect(main(page, "086520")).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => codes(page)).toEqual(["005930", "005935", "086520", "000660"]);
});

test("종목과 종목 사이에만 옅은 1px 선이 있고 줄 높이는 그대로다", async ({ scenario, page }) => {
  seed(scenario, FOUR, [{ id: "g1", name: "첫째", symbols: ["005930", "086520"] }]);
  await open(page);
  const lineShadow = await page.evaluate(() => {
    const el = document.createElement("i");
    el.style.boxShadow = "inset 0 1px 0 var(--line-subtle)";
    document.body.append(el);
    const computed = getComputedStyle(el).boxShadow;
    el.remove();
    return computed;
  });
  const lines = await panel(page).locator("li[data-code]").evaluateAll((items, line) => items.map((el) => ({
    code: el.getAttribute("data-code"),
    line: getComputedStyle(el).boxShadow.includes(line),
    height: (el as HTMLElement).offsetHeight,
  })), lineShadow);
  expect(lines).toEqual([
    { code: "005930", line: false, height: 34 },
    { code: "086520", line: true, height: 34 },
    { code: "005935", line: false, height: 34 },
    { code: "000660", line: true, height: 34 },
  ]);
});
