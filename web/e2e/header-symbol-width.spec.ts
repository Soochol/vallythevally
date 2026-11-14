import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cell, expect, test } from "./harness";

const SHORT = { code: "005930", name: "삼성", kind: "common", market: "kospi", nxtEnabled: false };
const LONG = { code: "0000D0", name: "KODEX 미국배당다우존스타겟커버드콜액티브", kind: "etf", market: "kospi", nxtEnabled: false };

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });

async function layout(page: Page) {
  return toolbar(page).evaluate((bar) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.width * 10) / 10]; };
    const symbol = bar.querySelector(".shell-symbol")!;
    const rest = [...bar.children].filter((el) => el !== symbol && !el.classList.contains("app-brand"));
    return { symbol: box(symbol)[1], rest: rest.map(box) };
  });
}

test("종목 이름 길이가 달라도 위 막대의 메뉴 자리와 폭이 같다", async ({ scenario, page }) => {
  scenario.reply("/api/symbols/005930", { body: SHORT });
  scenario.reply("/api/symbols/0000D0", { body: LONG });
  await mkdir(path.resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(toolbar(page).getByText("삼성", { exact: true })).toBeVisible();
    const short = await layout(page);
    await page.screenshot({ path: path.resolve(`../target/ux-screens/header-short-${size.width}.png`), clip: { x: 0, y: 0, width: size.width, height: 72 } });
    await page.goto("/?symbol=0000D0");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(toolbar(page).getByText(LONG.name)).toBeVisible();
    const long = await layout(page);
    await page.screenshot({ path: path.resolve(`../target/ux-screens/header-long-${size.width}.png`), clip: { x: 0, y: 0, width: size.width, height: 72 } });
    expect(long).toEqual(short);
    await expect(toolbar(page).getByText(LONG.name)).toHaveAttribute("title", LONG.name);
  }
});
