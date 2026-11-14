import type { BrowserContext, Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario } from "./harness";
import { TOOLS } from "../src/chart/drawings/tools";

test.use({ clockStart: "20261109100030" });

type Box = { left: number; top: number; right: number; bottom: number };

const dock = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" });
const PINNED_COUNTS = [1, 3, TOOLS.length];
const SYMBOLS = ["005930", "IDX:001"];

const unsavedKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("vv.unsaved.")));

async function load(context: BrowserContext, scenario: Scenario, width: number, symbol: string, pinned: readonly string[]): Promise<Page> {
  for (const open of context.pages()) {
    await expect.poll(() => unsavedKeys(open)).toEqual([]);
    await open.close();
  }
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: pinned }, revision: state.revision + 1 });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?symbol=${symbol}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  if (pinned.length > 0) await expect(dock(page).getByRole("button", { name: /고정 도구$/ }).first()).toBeVisible();
  await settled(page);
  return page;
}

async function legendRows(page: Page): Promise<Box[]> {
  return cell(page).locator(".chart-legend").evaluate((legend) => {
    const range = document.createRange();
    return Array.from(legend.children).flatMap((child) => getComputedStyle(child).flexDirection === "column" ? Array.from(child.children) : [child]).map((row) => {
      range.selectNodeContents(row);
      const { left, top, right, bottom } = range.getBoundingClientRect();
      return { left, top, right, bottom };
    }).filter((row) => row.right > row.left);
  });
}

async function settled(page: Page) {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await dock(page).boundingBox(), await legendRows(page)]);
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
}

const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const symbol of SYMBOLS) for (const width of [1440, 1280, 1024]) {
  test(`고정 도구: ${symbol} 창 폭 ${width}px에서 고정 도구 ${PINNED_COUNTS.join("·")}개는 범례를 밀거나 가리지 않고 넘치지 않으며 모두 고를 수 있다`, async ({ context, scenario }) => {
    const before = await legendRows(await load(context, scenario, width, symbol, []));
    for (const count of PINNED_COUNTS) {
      const pinned = TOOLS.slice(0, count);
      const page = await load(context, scenario, width, symbol, pinned.map((t) => t.tool));
      const label = `고정 ${count}개`;
      expect(await legendRows(page), `${label}: 범례 위치`).toEqual(before);
      const bar = (await dock(page).boundingBox())!;
      const barBox = { left: bar.x, top: bar.y, right: bar.x + bar.width, bottom: bar.y + bar.height };
      for (const row of await legendRows(page)) expect(meets(barBox, row), `${label}: 범례 줄과 겹침`).toBe(false);
      expect(await dock(page).evaluate((el) => el.scrollWidth - el.clientWidth), `${label}: 도구 막대 넘침`).toBe(0);
      const chart = (await chartOf(cell(page)).boundingBox())!;
      expect(barBox.left, label).toBeGreaterThanOrEqual(chart.x);
      const axis = (await cell(page).getByRole("group", { name: "가격축 방식" }).boundingBox())!;
      expect(barBox.right, `${label}: 가격축 쪽 끝`).toBeLessThanOrEqual(axis.x + axis.width);

      const shown = dock(page).getByRole("button", { name: /고정 도구$/ });
      const inline = await shown.count();
      expect(inline, `${label}: 막대에 보이는 고정 도구`).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < inline; i++) {
        const own = (await shown.nth(i).boundingBox())!;
        expect(own.x, label).toBeGreaterThanOrEqual(barBox.left);
        expect(own.x + own.width, label).toBeLessThanOrEqual(barBox.right);
      }
      await expect(shown.first()).toHaveAccessibleName(`${pinned[0]!.label} 고정 도구`);
      const folded = pinned.slice(inline);
      const toggle = dock(page).getByRole("button", { name: "고정 도구 펼치기", exact: true });
      if (folded.length === 0) { await expect(toggle).toHaveCount(0); continue; }
      await toggle.click();
      const menu = page.getByRole("menu", { name: "고정 도구", exact: true });
      await expect(menu.getByRole("menuitem")).toHaveText(folded.map((t) => startsWith(t.label)));
      const last = folded.at(-1)!;
      await menu.getByRole("menuitem").filter({ hasText: last.label }).scrollIntoViewIfNeeded();
      await menu.getByRole("menuitem").filter({ hasText: last.label }).click();
      await expect(menu).toBeHidden();
      await expect(dock(page).locator("button[aria-pressed=true][data-active-tool]")).toHaveAttribute("title", startsWith(last.label));
      await page.keyboard.press("Escape");
    }
  });
}
