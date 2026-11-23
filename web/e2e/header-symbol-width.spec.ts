import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { cell, expect, test } from "./harness";

const SHORT = { code: "005930", name: "삼성", kind: "common", market: "kospi", nxtEnabled: false };
const LONG = { code: "0000D0", name: "KODEX 미국배당다우존스타겟커버드콜액티브 합성 레버리지 인컴 프리미엄 혼합형 상장지수투자신탁", kind: "etf", market: "kospi", nxtEnabled: false };

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });

async function layout(page: Page) {
  return toolbar(page).evaluate((bar) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.width * 10) / 10]; };
    return { search: box(bar.querySelector(".shell-search")!), rest: [...bar.querySelectorAll(":scope > :not(.topbar-search-slot)")].map(box) };
  });
}

test("종목 이름 길이가 달라도 가운데 검색창과 위 막대의 메뉴 자리와 폭이 같다", async ({ scenario, page }) => {
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
    expect(await toolbar(page).getByText(LONG.name).evaluate((el) => {
      const style = getComputedStyle(el);
      return { overflows: el.scrollWidth > el.clientWidth, clipped: style.overflowX !== "visible", ellipsis: style.textOverflow };
    })).toEqual({ overflows: true, clipped: true, ellipsis: "ellipsis" });
  }
});

test("1024·1280·1440 창에서 위 막대가 넘치지 않고 검색창이 양쪽 구역과 겹치지 않는다", async ({ page }) => {
  for (const [width, minSearch] of [[1024, 220], [1280, 320], [1440, 400]] as const) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/?symbol=005930");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const m = await toolbar(page).evaluate((bar) => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const search = rect(bar.querySelector(".shell-search")!);
      const others = [...bar.querySelectorAll(":scope > :not(.topbar-search-slot)")].map(rect);
      const slot = rect(bar.querySelector(".topbar-search-slot")!);
      return {
        overflow: bar.scrollWidth - bar.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth,
        width: search.width, left: Math.max(...others.filter((r) => r.right <= slot.left + 1).map((r) => r.right)),
        right: Math.min(...others.filter((r) => r.left >= slot.right - 1).map((r) => r.left)), searchLeft: search.left, searchRight: search.right,
      };
    });
    expect(m.overflow, `${width} 막대 가로 넘침`).toBe(0);
    expect(m.page).toBe(0);
    expect(m.width).toBeGreaterThanOrEqual(minSearch);
    expect(m.searchLeft).toBeGreaterThanOrEqual(m.left);
    expect(m.searchRight).toBeLessThanOrEqual(m.right);
  }
});
