import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { allResult } from "./fixtures/screener";
import type { ScreenerResult } from "../src/api/generated/ScreenerResult";
import { cell, chartOf, expect, test } from "./screener-harness";
import { openScreener, panel, rows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";



test("결과 표 정렬과 키보드 이동, 행에서 Enter로 칸 열기를 연결한다", async ({ scenario, screener, page }) => {
  scenario.documents.saveScreens({ revision: 1, screens: [{ id: "all", name: "모든 종목", markets: [], exclude: [], conditions: [] }] });
  screener.showResult(allResult());
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const result: ScreenerResult = await (await response).json();
  await expect(rows(page)).toHaveCount(10);
  for (const descending of [true, false]) {
    await panel(page).getByRole("button", { name: "종가 순으로 정렬", exact: true }).click();
    await expect(panel(page).getByRole("columnheader", { name: "종가 순으로 정렬", exact: true })).toHaveAttribute("aria-sort", descending ? "descending" : "ascending");
    const prices = result.rows.map((r) => r.close).sort((a, b) => descending ? b - a : a - b);
    await expect.poll(() => rows(page).evaluateAll((items) => items.map((r) => Number(r.children[1]?.childNodes[0]?.textContent?.replaceAll(",", ""))))).toEqual(prices);
  }
  await rows(page).first().getByRole("button").click();
  const nextCode = await rows(page).nth(1).getAttribute("data-code");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => rows(page).filter({ has: page.locator('[aria-current="true"]') }).getAttribute("data-code")).toBe(nextCode);
  const next = result.rows.find((r) => r.symbol === nextCode)!;
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${next.name} 통합 일`);
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(`../target/ux-screens/screener-results-${size.width}x${size.height}.png`) });
  }
  const other = result.rows.find((r) => r.symbol !== nextCode)!;
  await rows(page).filter({ hasText: other.symbol }).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${other.name} 통합 일`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
});
