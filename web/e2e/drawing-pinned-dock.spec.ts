import type { BrowserContext, Page } from "@playwright/test";
import { cell, chartOf, expect, test, type Scenario } from "./harness";
import { TOOLS } from "../src/chart/drawings/tools";

test.use({ clockStart: "20261109100030" });

type Box = { left: number; top: number; right: number; bottom: number };

const dock = (page: Page) => page.getByRole("navigation", { name: "드로잉 도구" });
const PINNED_COUNTS = [1, 3, TOOLS.length];
const SYMBOLS = ["005930", "IDX:001"];

const unsavedKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("vv.unsaved.")));

async function load(context: BrowserContext, scenario: Scenario, height: number, symbol: string, pinned: readonly string[]): Promise<Page> {
  for (const open of context.pages()) {
    await expect.poll(() => unsavedKeys(open)).toEqual([]);
    await open.close();
  }
  const state = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...state, drawing: { ...scenario.documents.uiPrefs().drawing, pinnedTools: pinned }, revision: state.revision + 1 });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height });
  await page.goto(`/?symbol=${symbol}`);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
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

for (const symbol of SYMBOLS) for (const height of [900, 768, 700]) {
  test(`고정 도구: ${symbol} 창 높이 ${height}px에서 고정 도구 ${PINNED_COUNTS.join("·")}개는 범례를 밀거나 가리지 않고 넘치지 않으며 모두 고를 수 있다`, async ({ context, scenario }) => {
    const before = await legendRows(await load(context, scenario, height, symbol, []));
    for (const count of PINNED_COUNTS) {
      const pinned = TOOLS.slice(0, count);
      const page = await load(context, scenario, height, symbol, pinned.map((t) => t.tool));
      const label = `고정 ${count}개`;
      expect(await legendRows(page), `${label}: 범례 위치`).toEqual(before);
      const bar = (await dock(page).boundingBox())!;
      const barBox = { left: bar.x, top: bar.y, right: bar.x + bar.width, bottom: bar.y + bar.height };
      for (const row of await legendRows(page)) expect(meets(barBox, row), `${label}: 막대와 범례 줄 겹침`).toBe(false);
      expect(await dock(page).evaluate((el) => [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight]), `${label}: 도구 막대 넘침`).toEqual([0, 0]);
      const chart = (await chartOf(cell(page)).boundingBox())!;
      expect(barBox.right, label).toBeLessThanOrEqual(chart.x);

      const shown = dock(page).getByRole("button", { name: /고정 도구$/ });
      const inline = await shown.count();
      expect(inline, `${label}: 막대에 보이는 고정 도구`).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < inline; i++) {
        const own = (await shown.nth(i).boundingBox())!;
        expect(own.y, label).toBeGreaterThanOrEqual(barBox.top);
        expect(own.y + own.height, label).toBeLessThanOrEqual(barBox.bottom);
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

test("고정 도구: 접힌 메뉴는 첫 도구에 포커스를 두고 별표 없이 막대 오른쪽으로 열리며, 창 높이가 바뀌어도 막대 오른쪽에 머문다", async ({ context, scenario }) => {
  const page = await load(context, scenario, 900, "005930", TOOLS.slice(0, 14).map((t) => t.tool));
  const dot = dock(page).getByRole("button", { name: "고정 도구 펼치기", exact: true });
  await dot.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "고정 도구", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(0);
  expect(new Set(await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => Math.round(item.querySelector("svg")!.getBoundingClientRect().left)))).size, "접힌 메뉴의 아이콘 왼쪽 끝").toBe(1);
  const besideRail = async () => { const rail = (await dock(page).boundingBox())!; const open = (await menu.boundingBox())!; return open.x >= rail.x + rail.width - 1; };
  await expect.poll(besideRail).toBe(true);
  await page.setViewportSize({ width: 1440, height: 700 });
  await expect(menu).toBeVisible();
  await expect.poll(besideRail).toBe(true);
  await page.keyboard.press("Escape");
  const group = dock(page).getByRole("button", { name: "선 도구 펼치기", exact: true });
  await group.click();
  const lines = page.getByRole("menu", { name: "선 도구", exact: true });
  const star = lines.getByRole("menuitemcheckbox").last();
  const starred = await star.isChecked();
  await star.click();
  await expect(star).toBeChecked({ checked: !starred });
  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = (await dock(page).boundingBox())!;
  await expect.poll(async () => (await lines.boundingBox())!.x >= rail.x + rail.width - 1).toBe(true);
});
