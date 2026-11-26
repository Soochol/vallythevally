import { screenerScenario } from "./fixtures/screener";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import type { ScreenerResult } from "../src/api/generated/ScreenerResult";
import { panel, rows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";
import { barTimes, cell, chartOf, dragTowardPast, expect, SEARCH_BUTTON_TITLE, test, pollSaved } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";

test("초성으로 찾은 종목을 열고 과거로 끌면 과거 봉이 앞에 붙는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("ㅇㅋㅍㄹ");
  const ecopro = dialog.getByRole("option").filter({ hasText: "086520" });
  await expect(ecopro).toHaveAttribute("aria-disabled", "false");
  await ecopro.click();

  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 에코프로 통합 일");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-bar-count", "500");
  const latest = await barTimes(chart);

  await dragTowardPast(page, chart, () => expect(chart).toHaveAttribute("data-bar-count", "1000", { timeout: 500 }));
  const older = await barTimes(chart);
  expect(older.first).toBeLessThan(latest.first);

  await dragTowardPast(page, chart, () => expect(chart).toHaveAttribute("data-bar-count", "1200", { timeout: 500 }));
  const oldest = await barTimes(chart);
  expect(oldest.first).toBeLessThan(older.first);
});

test("검색어를 바꾼 뒤 새 결과가 오기 전에는 Enter가 이전 결과를 열지 않는다", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const isSecondQuery = (url: URL) => url.pathname === "/api/symbols" && url.searchParams.get("q") === "005930";
  await page.route(isSecondQuery, async (route) => {
    await held;
    await route.fallback();
  });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await cell(page).getAttribute("aria-label");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("ㅇㅋㅍㄹ");
  await expect(dialog.getByRole("option").filter({ hasText: "086520" })).toHaveAttribute("aria-disabled", "false");

  const secondSent = page.waitForRequest((r) => isSecondQuery(new URL(r.url())));
  await input.fill("005930");
  await secondSent;
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");

  release();
  await expect(dialog.getByRole("option").filter({ hasText: "삼성전자" }).first()).toHaveAttribute("aria-disabled", "false");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
});

test("초성 결과의 현재가·등락률·강조와 고른 한 종목의 추세가 보인다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox");
  await input.fill("ㅅㅅ");
  const samsung = dialog.getByRole("option").filter({ hasText: "005930" });
  await expect(samsung).toHaveAttribute("aria-disabled", "false");
  const quotes = [scenario.market.quote("005930")!];
  await expect(samsung.getByLabel("현재가")).toHaveText(quotes[0]!.price.toLocaleString("ko-KR"));
  const rate = quotes[0]!.changeRate;
  const magnitude = `${Math.abs(rate).toFixed(2)}%`;
  await expect(samsung.getByLabel("등락률").locator('[aria-hidden="true"]')).toHaveText(`${rate > 0 ? "▲ " : rate < 0 ? "▼ " : ""}${magnitude}`);
  await expect(samsung.getByLabel("등락률").locator(".sr-only")).toHaveText(`${rate > 0 ? "+" : rate < 0 ? "\u2212" : ""}${magnitude}`);
  await expect(samsung.locator("mark")).toHaveText(["삼성"]);
  await samsung.hover();
  await expect(dialog.getByRole("img", { name: "삼성전자 60일 추세" })).toBeVisible();
  await input.press("Enter");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await page.keyboard.press("Control+k");
  await expect(dialog.getByRole("listbox")).toContainText("최근 본 종목");
  await expect(dialog.getByRole("option").filter({ hasText: "005930" })).toHaveCount(1);
});

test("Ctrl+Enter로 관심종목을 넣고 빼며 Shift+Enter는 비교에 추가한다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await cell(page).getAttribute("aria-label");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  for (const expected of ["기본에 넣었습니다", "기본에서 뺐습니다"]) {
    await page.keyboard.press("Control+k");
    await dialog.getByRole("combobox").fill("005930");
    await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
    await dialog.getByRole("combobox").press("Control+Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: expected })).toBeVisible();
    await expect(cell(page)).toHaveAttribute("aria-label", before!);
  }
  await page.keyboard.press("Control+k");
  await dialog.getByRole("combobox").fill("005930");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  await dialog.getByRole("combobox").press("Shift+Enter");
  await expect(dialog).toBeHidden();
  await expect(cell(page).locator('[data-compare-row="005930"]')).toBeVisible();
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
});

test("시장 필터와 > 명령 모드에서 명령을 실행한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox");
  await input.fill("005930");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  await dialog.getByRole("button", { name: "코스닥", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog.getByRole("button", { name: "전체", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await input.fill("> 로그 축");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "log");
  await page.keyboard.press("/");
  await input.fill("> 지표");
  await input.press("Enter");
  await expect(page.getByRole("dialog", { name: "지표·비교 입력창", exact: true })).toBeVisible();
});

test("일부 시세 누락·추세 실패에도 다른 종목과 명령을 계속 고른다", async ({ scenario, page }) => {
  await page.route("**/api/quotes?*", async (route) => {
    const response = await scenario.respond(route.request());
    const quotes = (response.body ?? []) as { symbol: string }[];
    await route.fulfill({ json: quotes.filter((q: { symbol: string }) => q.symbol !== "006400") });
  });
  await page.route((url) => url.pathname === "/api/bars" && url.searchParams.get("limit") === "60", (route) => route.fulfill({ status: 503, json: { code: "unavailable", message: "시험 실패" } }));
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill("ㅅㅅ");
  const samsung = dialog.getByRole("option").filter({ hasText: "005930" });
  await expect(samsung.getByLabel("현재가")).not.toHaveText("—");
  await expect(dialog.getByRole("option").filter({ hasText: "006400" }).getByLabel("현재가")).toHaveText("");
  await expect(dialog.getByRole("option").filter({ hasText: "006400" }).getByLabel("등락률")).toHaveText("—");
  await expect(dialog.getByRole("alert")).toContainText("추세를 받지 못했습니다");
  await samsung.click();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
});

test("시장 표시는 값이 없는 줄도 있는 줄과 같은 왼쪽 끝에 서고 맞은 글자는 강조색이 아니다", async ({ scenario, page }) => {
  await page.route("**/api/quotes?*", async (route) => {
    const response = await scenario.respond(route.request());
    const quotes = (response.body ?? []) as { symbol: string }[];
    await route.fulfill({ json: quotes.filter((q: { symbol: string }) => q.symbol !== "006400") });
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill("ㅅㅅ");
  const withValue = dialog.getByRole("option").filter({ hasText: "005930" });
  const withoutValue = dialog.getByRole("option").filter({ hasText: "006400" });
  await expect(withValue.getByLabel("현재가")).not.toHaveText("");
  await expect(withoutValue.getByLabel("등락률")).toHaveText("—");
  const left = async (row: Locator) => (await row.locator('[data-cell="market"]').boundingBox())!.x;
  expect(await left(withoutValue)).toBe(await left(withValue));
  const colors = await dialog.evaluate((root) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    root.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { accent, marked: getComputedStyle(root.querySelector("mark")!).color };
  });
  expect(colors.marked).not.toBe(colors.accent);
});

test("코스닥 필터로 결과가 없으면 전체에서 찾기가 보이고 누르면 결과가 나온다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill("005930");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  await dialog.getByRole("button", { name: "코스닥", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(dialog).toContainText("조건에 맞는 종목이 없습니다");
  await expect(dialog).toContainText("코스닥 안에서는 찾지 못했습니다");
  await dialog.getByRole("button", { name: "전체에서 찾기", exact: true }).click();
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "전체", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("명령 모드의 명령 아이콘은 서로 다르고 미리보기 칸은 접히며 바닥 안내는 실행과 닫기뿐이다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill(">");
  const icons = await dialog.getByRole("option").evaluateAll((rows) => rows.slice(0, 3).map((row) => row.querySelector("svg")?.innerHTML ?? ""));
  expect(icons).toHaveLength(3);
  expect(icons.every((markup) => markup !== "")).toBe(true);
  expect(new Set(icons).size).toBe(3);
  await expect(dialog.getByRole("complementary")).toHaveCount(0);
  await expect(dialog.getByText("고르기")).toHaveCount(0);
  await expect(dialog.locator("kbd", { hasText: "↵" })).toHaveCount(1);
});

test.describe("검색에서 스크리너 실행", () => {
  test.use({ clockStart: "20261106203000" });
  test("관심종목 탭을 보는 중에 명령으로 스크리너 탭을 골라 저장된 조건식을 실행하고 차트를 유지한다", async ({ page, scenario }) => {
    screenerScenario(scenario);
    scenario.documents.saveScreens({ revision: 1, screens: [{ id: "search-run", name: "검색에서 실행", markets: [], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }] }] });

    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const chartLabel = await cell(page).getAttribute("aria-label");
    const tabs = page.getByRole("tablist", { name: "창 묶음 2" });
    await tabs.getByRole("tab", { name: "관심종목", exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await page.keyboard.press("/");
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    await dialog.getByRole("combobox").fill("> 스크리너");
    await dialog.getByRole("combobox").press("Enter");
    await expect(panel(page)).toBeVisible();
    await expect(tabs.getByRole("tab", { name: /^스크리너/ })).toHaveAttribute("aria-selected", "true");
    await expect(cell(page)).toBeVisible();
    await expect(cell(page)).toHaveAttribute("aria-label", chartLabel!);
    await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
    await waitForUpdateToFinish(page, "11-06(금)");
    await tabs.getByRole("tab", { name: "관심종목", exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await page.keyboard.press("/");
    await dialog.getByRole("combobox").fill("> 스크리너");
    const run = page.waitForResponse((r) => r.url().endsWith("/api/screener/run") && r.ok());
    await dialog.getByRole("combobox").press("Enter");
    const commandResult: ScreenerResult = await (await run).json();
    const expectedSymbols = ["110030", "110035", "110040", "110050"];
    expect(commandResult).toMatchObject({ asOf: "2026-11-06", missingSummary: 0 });
    expect(commandResult.rows.map((row) => row.symbol)).toEqual(expectedSymbols);
    await expect(rows(page)).toHaveCount(4);
    await expect.poll(() => rows(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-code")))).toEqual(expectedSymbols);
    const directRun = page.waitForResponse((response) => response.url().endsWith("/api/screener/run") && response.ok());
    await runButton(page).click();
    const directResult: ScreenerResult = await (await directRun).json();
    expect(directResult).toMatchObject({ asOf: "2026-11-06", missingSummary: 0 });
    expect(directResult.rows).toEqual(commandResult.rows);
    await expect(rows(page)).toHaveCount(4);
    await expect(tabs.getByRole("tab", { name: /^스크리너/ })).toHaveAttribute("aria-selected", "true");
    await expect(cell(page)).toBeVisible();
    await expect(cell(page)).toHaveAttribute("aria-label", chartLabel!);
  });
});

for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
  test(`검색 입력·빈 입력 화면은 ${width}×${height} 안에 들어간다`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await page.keyboard.press("/");
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    const input = dialog.getByRole("combobox");
    await input.fill("005930");
    await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
    await input.press("Control+Enter");
    await page.keyboard.press("Control+k");
    await input.fill("005930");
    await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
    await input.press("Enter");
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
    await page.keyboard.press("Control+k");
    await input.fill("ㅅㅅ");
    await expect(dialog.getByRole("option").filter({ hasText: "005930" }).getByLabel("현재가")).not.toHaveText("—");
    if (width >= 768) {
      await dialog.getByRole("option").filter({ hasText: "005930" }).hover();
      await expect(dialog.getByRole("img", { name: "삼성전자 60일 추세" })).toBeVisible();
    }
    const directory = path.resolve(import.meta.dirname, "../../target/ux-screens");
    await mkdir(directory, { recursive: true });
    for (const state of ["query", "empty"]) {
      if (state === "empty") {
        await input.fill("");
        await expect(dialog.getByRole("listbox")).toContainText("최근 본 종목");
        await expect(dialog.getByRole("option").filter({ hasText: "지표 추가" })).toBeVisible();
        await expect(dialog.getByRole("option").filter({ hasText: "005930" }).first().getByLabel("현재가")).not.toHaveText("—");
      }
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: path.join(directory, `search-${width}x${height}-${state}.png`) });
    }
  });
}

test("화면에 보이는 결과만 묶어서 시세를 묻고 스크롤하면 다음 묶음을 받는다", async ({ page }) => {
  const infos = Array.from({ length: 30 }, (_, i) => ({ code: String(990000 + i), name: `합성 종목 ${i}`, kind: "common", market: "kospi", nxtEnabled: false }));
  const batches: string[][] = [];
  await page.route("**/api/symbols?q=BATCH", (route) => route.fulfill({ json: infos }));
  await page.route("**/api/quotes?*", (route) => {
    const codes = new URL(route.request().url()).searchParams.get("symbols")!.split(",");
    if (codes.some((code) => code.startsWith("99"))) batches.push(codes);
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill("batch");
  await expect(dialog.getByRole("option")).toHaveCount(30);
  await pollSaved(() => batches.length).toBe(1);
  expect(batches[0]).toContain("990000");
  expect(batches[0]).not.toContain("990029");
  expect(batches[0]!.length).toBeLessThan(30);
  await dialog.getByRole("listbox").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await pollSaved(() => batches.length).toBe(2);
  expect(batches[1]).toContain("990029");
  expect(batches[1]).not.toContain("990000");
});

test("Tab은 검색 안에 머물고 필터 버튼의 Enter는 종목을 열지 않는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const opener = page.getByRole("button", { name: "종목·지표·명령 찾기", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox");
  await input.fill("005930");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  const filter = dialog.getByRole("button", { name: "ETF", exact: true });
  await filter.focus();
  await page.keyboard.press("Enter");
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await dialog.getByRole("button").last().focus();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("시세의 첫 실패는 다시 받고 도중 실패에도 종목 열기를 막지 않는다", async ({ page, scenario }) => {
  let failQuotes = true;
  await page.route("**/api/quotes?*", (route) => failQuotes
    ? route.fulfill({ status: 503, json: { code: "unavailable", message: "시세 시험 실패" } })
    : route.fallback());
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox");
  await input.fill("005930");
  const error = dialog.getByRole("alert").filter({ hasText: "시세를 받지 못했습니다" });
  await expect(error).toBeVisible();
  failQuotes = false;
  await error.getByRole("button", { name: "다시 시도" }).click();
  await expect(dialog.getByRole("option").getByLabel("현재가")).toHaveText(scenario.market.quote("005930")!.price.toLocaleString("ko-KR"));
  await expect(error).toBeHidden();
  failQuotes = true;
  await input.fill("006400");
  await expect(error).toBeVisible();
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성SDI 통합 일");
});

test("관심종목 용도로 연 검색은 바닥 줄의 Enter 안내가 넣기이며 차트를 바꾸지 않고 창을 닫지 않는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await cell(page).getAttribute("aria-label");
  const watchlist = page.getByRole("complementary", { name: "관심종목", exact: true });
  await watchlist.getByRole("button", { name: "관심종목에 넣기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("005930");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  const preview = dialog.getByRole("complementary", { name: "종목 미리보기" });
  await expect(preview.locator("kbd")).toHaveCount(0);
  const footer = dialog.getByRole("group", { name: "키 안내" });
  await expect(footer.locator("kbd")).toHaveText(["↵", "Tab", "Esc"]);
  await expect(footer).toContainText("넣기");
  await expect(footer).not.toContainText("열기");
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(watchlist.locator('li[data-code="005930"]')).toHaveCount(1);
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
});

const star = (option: Locator, action: string) => option.locator(`[title="${action} · Ctrl+↵"], [aria-description="${action} · Ctrl+↵"]`);

test("검색 별을 누르면 창을 닫지 않고 지금 목록에 넣고 빼며 활성 칸을 바꾸지 않는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await cell(page).getAttribute("aria-label");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await page.keyboard.press("Control+k");
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("005930");
  const option = dialog.getByRole("option").filter({ hasText: "005930" });
  await expect(option).toHaveAttribute("aria-disabled", "false");
  await option.hover();
  const addStar = star(option, "기본에 넣기");
  await expect(addStar).toBeVisible();
  await addStar.click();
  await expect(page.getByRole("status").filter({ hasText: "기본에 넣었습니다" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await expect(option).toContainText("관심종목");
  const removeStar = star(option, "기본에서 빼기");
  await removeStar.click();
  await expect(page.getByRole("status").filter({ hasText: "기본에서 뺐습니다" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(star(option, "기본에 넣기")).toHaveCount(1);
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
});

test("+종목으로 연 검색에서도 별이 같은 일을 하고 창은 열린 채 남는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await cell(page).getAttribute("aria-label");
  const watchlist = page.getByRole("complementary", { name: "관심종목", exact: true });
  await watchlist.getByRole("button", { name: "관심종목에 넣기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
  const input = dialog.getByRole("combobox", { name: "종목 검색" });
  await input.fill("005930");
  const option = dialog.getByRole("option").filter({ hasText: "005930" });
  await expect(option).toHaveAttribute("aria-disabled", "false");
  await option.hover();
  await star(option, "기본에 넣기").click();
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await expect(watchlist.locator('li[data-code="005930"]')).toHaveCount(1);
  await star(option, "기본에서 빼기").click();
  await expect(watchlist.locator('li[data-code="005930"]')).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-label", before!);
});

test("종류가 ETN인 종목은 검색 결과에 종류 이름 ETN과 함께 보인다", async ({ page, scenario }) => {
  const etn = { code: "520100", name: "합성 레버리지 ETN", market: "kospi", kind: "etn", nxtEnabled: false };
  scenario.on("/api/symbols", request => ({ body: (new URL(request.url()).searchParams.get("q") ?? "") === "520100" ? [etn] : [] }));
  scenario.reply("/api/symbols/520100", { body: etn });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill("520100");
  const row = dialog.getByRole("option").filter({ hasText: "520100" });
  await expect(row).toHaveAttribute("aria-disabled", "false");
  await expect(row.getByText("ETN", { exact: true })).toBeVisible();
});
