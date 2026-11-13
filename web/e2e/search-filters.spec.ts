import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SymbolInfo } from "../src/api/generated/SymbolInfo";
import { cell, expect, test } from "./harness";

const stocks = (base: number, prefix: string, market: SymbolInfo["market"], kind: SymbolInfo["kind"] = "common") => Array.from({ length: 25 }, (_, i) => ({
  code: String(base + i * 10), name: `${prefix}${String(i).padStart(2, "0")}`, market, kind, nxtEnabled: false,
}));
const kospi = stocks(100000, "삼가", "kospi");
const kosdaq = stocks(200000, "삼나", "kosdaq");
const etfs = stocks(300000, "삼다", "kospi", "etf");

test.beforeEach(async ({ scenario }) => {
  scenario.on("/api/symbols", request => {
    const query = new URL(request.url()).searchParams;
    const dataset = query.get("kind") === "etf" ? etfs : query.get("market") === "kosdaq" ? kosdaq : kospi;
    const q = query.get("q") ?? "";
    return { body: dataset.filter(value => value.code.includes(q) || value.name.includes(q)).slice(0, 20) };
  });
  for (const info of [...kospi, ...kosdaq, ...etfs]) scenario.reply(`/api/symbols/${info.code}`, { body: info });
});

test("짧은 검색어의 시장·ETF 조건을 20개 상한 전에 적용하고 해제하면 원래 결과로 돌아간다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const input = dialog.getByRole("combobox");
  const options = dialog.getByRole("option");
  const codes = () => options.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-symbol")));
  const original: SymbolInfo[] = kospi.slice(0, 20);
  expect(original.map((info) => info.code)).toEqual(kospi.slice(0, 20).map((info) => info.code));
  await input.fill("삼");
  await expect.poll(codes).toEqual(original.map((info) => info.code));

  for (const [label, param, value, expected] of [
    ["코스닥", "market", "kosdaq", kosdaq], ["ETF", "kind", "etf", etfs], ["코스피", "market", "kospi", kospi],
  ] as const) {
    const response = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return url.pathname === "/api/symbols" && url.searchParams.get("q") === "삼" && url.searchParams.get(param) === value;
    });
    await dialog.getByRole("button", { name: label, exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect.poll(codes).toEqual(expected.slice(0, 20).map((info) => info.code));
    await expect(options.first()).toHaveAttribute("aria-disabled", "false");
    if (label === "코스닥") {
      const directory = path.resolve(import.meta.dirname, "../../target/ux-screens");
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: path.join(directory, "search-filter-1440x900-kosdaq.png") });
    }
  }
  await dialog.getByRole("button", { name: "전체", exact: true }).click();
  await expect.poll(codes).toEqual(original.map((info) => info.code));
});

test("필터에 맞는 결과가 없으면 안내하고 입력을 지우면 회복할 수 있다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox").fill("100000");
  await expect(dialog.getByRole("option")).toHaveAttribute("aria-disabled", "false");
  await dialog.getByRole("button", { name: "ETF", exact: true }).click();
  await expect(dialog.getByText("조건에 맞는 종목이 없습니다", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("option")).toHaveCount(0);
  const directory = path.resolve(import.meta.dirname, "../../target/ux-screens");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "search-filter-1440x900-no-results.png") });
  await dialog.getByRole("button", { name: "입력 지우기", exact: true }).click();
  await expect(dialog.getByRole("combobox")).toBeEmpty();
  await expect(dialog.getByRole("combobox")).toBeFocused();
  await expect(dialog.getByRole("option").filter({ hasText: "지표 추가" })).toBeVisible();
});

test("같은 검색어의 필터 응답을 기다리는 동안 Enter는 이전 결과를 열지 않는다", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const filtered = (url: URL) => url.pathname === "/api/symbols" && url.searchParams.get("market") === "kosdaq";
  await page.route(filtered, async (route) => { await held; await route.fallback(); });
  try {
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const before = await cell(page).getAttribute("aria-label");
    await page.keyboard.press("/");
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    const input = dialog.getByRole("combobox");
    await input.fill("삼");
    await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-disabled", "false");
    const requested = page.waitForRequest((r) => filtered(new URL(r.url())));
    await dialog.getByRole("button", { name: "코스닥", exact: true }).click();
    await requested;
    await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");
    await input.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(cell(page)).toHaveAttribute("aria-label", before!);
    release();
    await expect(dialog.getByRole("option").first()).toHaveAttribute("data-symbol", "200000");
    await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-disabled", "false");
  } finally {
    release();
  }
});
