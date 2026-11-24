import type { Locator, Page } from "@playwright/test";
import type { ViState } from "../src/api/generated/ViState";
import { type Scenario, expect, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const SAMSUNG = "005930";
const SAMSUNG_PREFERRED = "005935";
const HYNIX = "000660";
const LONG = "950000";
const LONG_NAME = "이름이아주길어서관심종목줄에다들어가지않는합성종목우선주전환";
const TRIGGERED_AT = 1794186000;

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const main = (page: Page, code: string) => row(page, code).locator("[data-main]");
const badge = (page: Page, code: string) => row(page, code).getByTestId("watch-vi");
const nameText = (page: Page, code: string) => row(page, code).locator("b").first();

const firing = (symbol: string, direction: ViState["direction"]): ViState => ({ symbol, active: true, direction, triggerPrice: direction === null ? null : 77_000, base: 70_000, triggeredAt: TRIGGERED_AT, releasedAt: null });
const released = (symbol: string): ViState => ({ ...firing(symbol, "up"), active: false, base: null, releasedAt: TRIGGERED_AT + 134 });

async function openWith(page: Page, scenario: Scenario, symbols: string[]) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => (i === 0 ? { ...list, symbols } : list)), revision: current.revision + 1 });
  scenario.reply(`/api/symbols/${LONG}`, { body: { code: LONG, name: LONG_NAME, kind: "common", market: "kospi", nxtEnabled: false } });
  scenario.reply("/api/quotes", { body: symbols.map((symbol) => ({ symbol, price: 71_000, change: 100, changeRate: 1.5, volume: 1_000, t: TRIGGERED_AT, source: "polled", venue: "combined" })) });
  await page.goto("/");
  for (const code of symbols) await expect(row(page, code)).toContainText("71,000");
}

const tokenColor = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);

async function box(target: Locator) {
  const found = await target.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

test("VI가 걸린 종목 이름 오른쪽에만 방향색 배지가 붙고 해제되면 떨어진다", async ({ page, scenario }) => {
  await openWith(page, scenario, [SAMSUNG, SAMSUNG_PREFERRED, HYNIX]);
  await expect(panel(page).getByTestId("watch-vi")).toHaveCount(0);
  const heightBefore = (await box(row(page, SAMSUNG))).height;

  scenario.live.emit({ type: "vi_update", state: firing(SAMSUNG, "up") });
  await expect(badge(page, SAMSUNG)).toBeVisible();
  await expect(panel(page).getByTestId("watch-vi")).toHaveCount(1);
  scenario.live.emit({ type: "vi_update", state: firing(SAMSUNG_PREFERRED, "down") });
  scenario.live.emit({ type: "vi_update", state: firing(HYNIX, null) });

  for (const [code, token] of [[SAMSUNG, "--up"], [SAMSUNG_PREFERRED, "--down"], [HYNIX, "--text-2"]] as const) {
    const color = await tokenColor(page, token);
    await expect(badge(page, code)).toHaveCSS("color", color);
    await expect(badge(page, code)).toHaveCSS("border-top-color", color);
    await expect(badge(page, code)).toHaveCSS("border-top-width", "1px");
    await expect(badge(page, code)).toHaveCSS("font-size", "11px");
    const badgeBox = await box(badge(page, code));
    const nameBox = await box(nameText(page, code));
    expect(badgeBox.height).toBe(16);
    expect(badgeBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
  }
  expect((await box(row(page, SAMSUNG))).height).toBe(heightBefore);
  await expect(main(page, SAMSUNG)).toHaveAccessibleName(/^삼성전자 상승 VI 71,000 /);
  await expect(main(page, SAMSUNG_PREFERRED)).toHaveAccessibleName(/^삼성전자우 하락 VI 71,000 /);
  await expect(main(page, HYNIX)).toHaveAccessibleName(/^SK하이닉스 VI 71,000 /);

  scenario.live.emit({ type: "vi_update", state: released(SAMSUNG) });
  await expect(badge(page, SAMSUNG)).toHaveCount(0);
  await expect(main(page, SAMSUNG)).toHaveAccessibleName(/^삼성전자 71,000 /);
  await expect(badge(page, SAMSUNG_PREFERRED)).toBeVisible();
  await expect(badge(page, HYNIX)).toBeVisible();
});

test("이름이 길면 이름이 먼저 잘리고 배지는 그대로다", async ({ page, scenario }) => {
  await openWith(page, scenario, [SAMSUNG, LONG]);
  await expect(nameText(page, LONG)).toHaveText(LONG_NAME);
  scenario.live.emit({ type: "vi_snapshot", states: [firing(SAMSUNG, "up"), firing(LONG, "up")] });
  await expect(badge(page, SAMSUNG)).toBeVisible();
  await expect(badge(page, LONG)).toBeVisible();
  const longBadge = await box(badge(page, LONG));
  expect(longBadge.width).toBe((await box(badge(page, SAMSUNG))).width);
  expect(longBadge.x + longBadge.width).toBeLessThanOrEqual((await box(row(page, LONG).locator("[data-cell]").first())).x);
  expect(await nameText(page, LONG).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});
