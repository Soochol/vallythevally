import type { Page } from "@playwright/test";
import { HEATMAP_TABLE, heatmapQuote, seedHeatmapThemes } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109085500" });

const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const tile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);
const watched = (scenario: Scenario, code: string) => scenario.live.messages.some((m) => m.type === "watch" && m.symbols.includes(code));
const quote = (rate: number, price: number) => ({ ...heatmapQuote("000660", { rate, traded: 200_000 }, "realtime"), price });

test("예상 시세 타일은 등락률 뒤와 카드 현재가 뒤에 별표를 단다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  await page.goto("/heatmap?view=board&size=equal&order=custom");
  const target = tile(page, "000660");
  await expect(target).toHaveAttribute("data-side", "down");
  await pollSaved(() => watched(scenario, "000660")).toBe(true);
  const before = await target.boundingBox();

  scenario.live.emit({ type: "quotes", venue: "krx", quotes: [{ ...quote(5, 120_000), source: "expected" }] });
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [{ ...quote(9, 123_400), source: "expected" }] });
  await expect(target).toHaveAccessibleName("SK하이닉스 +9.00% 예상체결");
  await expect(target.locator(".hm-tile-rate")).toHaveText("+9.00%*");
  await expect(target).not.toHaveAttribute("title", /.+/);
  expect(await target.boundingBox()).toEqual(before);

  await target.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText("123,400*");

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quote(8, 122_000)] });
  await expect(target).toHaveAccessibleName("SK하이닉스 +8.00%");
  await expect(target.locator(".hm-tile-rate")).toHaveText("+8.00%");
  await expect(card).toContainText("122,000");
  await expect(card).not.toContainText("*");
});
