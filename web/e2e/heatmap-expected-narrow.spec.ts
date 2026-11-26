import type { Page } from "@playwright/test";
import type { HeatmapThemes } from "../src/api/generated/HeatmapThemes";
import { heatmapQuote, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109085500" });

const CODES = Array.from({ length: 48 }, (_, i) => String(200_001 + i));
const EXPECTED_RATES = [9, 29.98, -12.34] as const;

const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const watched = (scenario: Scenario, code: string) => scenario.live.messages.some((m) => m.type === "watch" && m.symbols.includes(code));
const tradedFor = (index: number) => (index < 12 ? 13_500 : 10_000);

function narrowThemes(): HeatmapThemes {
  return { revision: 100, themes: [{ id: "narrow", name: "좁은테마", symbols: CODES }] };
}

function initialTable(): HeatmapTable {
  return Object.fromEntries(CODES.map((code, i) => [code, { rate: i % 2 === 0 ? 1.5 : -1.5, traded: tradedFor(i) }]));
}

async function verifyExpectedTiles(
  page: Page,
  scenario: Scenario,
  viewport: { width: number; height: number },
  minCounts: { narrowRate?: number; wideRate?: number },
) {
  await page.setViewportSize(viewport);
  seedHeatmapThemes(scenario, initialTable(), narrowThemes());
  await page.goto("/heatmap?view=board&order=custom");
  const tiles = main(page).locator(".hm-tile");
  await expect(tiles).toHaveCount(CODES.length);
  await pollSaved(() => watched(scenario, CODES[CODES.length - 1]!)).toBe(true);

  const before = new Map<string, { x: number; y: number; width: number; height: number }>();
  let rateTileCount = 0;
  let narrowRateCount = 0;
  let wideRateCount = 0;
  for (const code of CODES) {
    const target = main(page).locator(`.hm-tile[data-code="${code}"]`);
    const box = (await target.boundingBox())!;
    before.set(code, box);
    if ((await target.locator(".hm-tile-rate").count()) > 0) {
      rateTileCount += 1;
      if ((await target.locator(".hm-tile-name").count()) === 0 && box.width >= 44 && box.width < 64) {
        narrowRateCount += 1;
      }
      if (box.width >= 64) {
        wideRateCount += 1;
      }
    }
  }
  if (minCounts.narrowRate !== undefined) expect(narrowRateCount).toBeGreaterThanOrEqual(minCounts.narrowRate);
  if (minCounts.wideRate !== undefined) expect(wideRateCount).toBeGreaterThanOrEqual(minCounts.wideRate);

  scenario.live.emit({
    type: "quotes",
    venue: "combined",
    quotes: CODES.map((code, i) => heatmapQuote(code, { rate: EXPECTED_RATES[i % EXPECTED_RATES.length]!, traded: tradedFor(i) }, "expected")),
  });

  await expect(main(page).locator('.hm-tile-rate [aria-hidden="true"]')).toHaveCount(rateTileCount);

  for (const code of CODES) {
    const target = main(page).locator(`.hm-tile[data-code="${code}"]`);
    const tileBox = (await target.boundingBox())!;
    expect(tileBox).toEqual(before.get(code));
    if ((await target.locator(".hm-tile-rate").count()) === 0) continue;
    const star = target.locator('.hm-tile-rate [aria-hidden="true"]');
    await expect(star).toHaveText("*");
    const starBox = (await star.boundingBox())!;
    expect(starBox.width).toBeGreaterThan(0);
    expect(starBox.height).toBeGreaterThan(0);
    expect(starBox.x).toBeGreaterThanOrEqual(tileBox.x);
    expect(starBox.y).toBeGreaterThanOrEqual(tileBox.y);
    expect(starBox.x + starBox.width).toBeLessThanOrEqual(tileBox.x + tileBox.width);
    expect(starBox.y + starBox.height).toBeLessThanOrEqual(tileBox.y + tileBox.height);
    if (tileBox.width >= 64) {
      const value = await target.locator(".hm-tile-rate-value").evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
    }
  }
}

test("좁은 타일에서도 예상 별표는 타일 밖으로 잘리지 않는다", async ({ page, scenario }) => {
  await verifyExpectedTiles(page, scenario, { width: 562, height: 900 }, { narrowRate: 10, wideRate: 1 });
});

test("1280×900의 폭 64px 이상 타일은 별표가 붙어도 숫자가 잘리지 않는다", async ({ page, scenario }) => {
  await verifyExpectedTiles(page, scenario, { width: 1280, height: 900 }, { wideRate: 10 });
});
