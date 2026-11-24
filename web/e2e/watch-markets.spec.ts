import type { Locator, Page } from "@playwright/test";
import type { ViMarket } from "../src/api/generated/ViMarket";
import type { ViState } from "../src/api/generated/ViState";
import { type Scenario, expect, pickDesktopVenue, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const SAMSUNG = "005930";
const PREFERRED = "005935";
const LONG = "950000";
const LONG_NAME = "이름이아주길어서관심종목줄에다들어가지않는합성종목우선주전환";
const TRIGGERED_AT = 1794186000;

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const main = (page: Page, code: string) => row(page, code).locator("[data-main]");
const badge = (page: Page, code: string, market: ViMarket) => row(page, code).locator(`[data-testid="watch-vi"][data-market="${market}"]`);
const nameText = (page: Page, code: string) => row(page, code).locator("b").first();

const firing = (symbol: string, market: ViMarket, direction: ViState["direction"] = "up"): ViState => ({ symbol, market, active: true, direction, triggerPrice: 77_000, base: 70_000, triggeredAt: TRIGGERED_AT, releasedAt: null });
const released = (symbol: string, market: ViMarket): ViState => ({ ...firing(symbol, market), active: false, base: null, releasedAt: TRIGGERED_AT + 120 });

async function openWith(page: Page, scenario: Scenario, symbols: string[]) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => (i === 0 ? { ...list, symbols } : list)), revision: current.revision + 1 });
  scenario.reply(`/api/symbols/${LONG}`, { body: { code: LONG, name: LONG_NAME, kind: "common", market: "kospi", nxtEnabled: true } });
  scenario.on("/api/quotes", (request) => {
    const query = new URL(request.url()).searchParams;
    return { body: query.get("symbols")!.split(",").map((symbol) => ({ symbol, price: 71_000, change: 100, changeRate: 1.5, volume: 1_000, t: TRIGGERED_AT, source: "polled" as const, venue: query.get("venue") === "krx" ? "krx" as const : "combined" as const })) };
  });
  await page.goto("/");
  for (const code of symbols) await expect(row(page, code)).toContainText("71,000");
}

async function box(target: Locator) {
  const found = await target.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

const tokenColor = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);

test("KVI와 NVI는 시장 글자로 나뉘고 앱 거래소를 바꿔도 둘 다 보이며 따로 떨어진다", async ({ page, scenario }) => {
  await openWith(page, scenario, [SAMSUNG, PREFERRED]);
  scenario.live.emit({ type: "vi_update", state: firing(SAMSUNG, "krx") });
  scenario.live.emit({ type: "vi_update", state: firing(SAMSUNG, "nxt", "down") });
  scenario.live.emit({ type: "vi_update", state: firing(PREFERRED, "nxt") });
  await expect(badge(page, SAMSUNG, "krx")).toContainText("KVI");
  await expect(badge(page, SAMSUNG, "nxt")).toContainText("NVI");
  await expect(badge(page, PREFERRED, "krx")).toHaveCount(0);
  await expect(badge(page, PREFERRED, "nxt")).toBeVisible();
  await expect(badge(page, SAMSUNG, "krx")).toHaveCSS("color", await tokenColor(page, "--up"));
  await expect(badge(page, SAMSUNG, "nxt")).toHaveCSS("color", await tokenColor(page, "--down"));
  await expect(badge(page, PREFERRED, "nxt")).toHaveCSS("color", await tokenColor(page, "--up"));
  await expect(main(page, SAMSUNG)).toHaveAccessibleName(/^삼성전자 상승 KVI 하락 NVI 71,000 /);

  await pickDesktopVenue(page, "KRX");
  await expect(row(page, SAMSUNG)).toContainText("71,000");
  await expect(badge(page, SAMSUNG, "krx")).toBeVisible();
  await expect(badge(page, SAMSUNG, "nxt")).toBeVisible();

  scenario.live.emit({ type: "vi_update", state: released(SAMSUNG, "krx") });
  await expect(badge(page, SAMSUNG, "krx")).toHaveCount(0);
  await expect(badge(page, SAMSUNG, "nxt")).toBeVisible();
  await expect(main(page, SAMSUNG)).toHaveAccessibleName(/^삼성전자 하락 NVI 71,000 /);
});

test("둘 다 걸리면 KVI, NVI 순으로 나란하고 이름이 먼저 잘린다", async ({ page, scenario }) => {
  await openWith(page, scenario, [SAMSUNG, LONG]);
  const height = (await box(row(page, LONG))).height;
  for (const code of [SAMSUNG, LONG]) for (const market of ["krx", "nxt"] as const) scenario.live.emit({ type: "vi_update", state: firing(code, market) });
  for (const code of [SAMSUNG, LONG]) {
    for (const market of ["krx", "nxt"] as const) await expect(badge(page, code, market)).toBeVisible();
    const name = await box(nameText(page, code));
    const kvi = await box(badge(page, code, "krx"));
    const nvi = await box(badge(page, code, "nxt"));
    expect(kvi.x).toBeGreaterThanOrEqual(name.x + name.width);
    expect(nvi.x).toBeGreaterThanOrEqual(kvi.x + kvi.width);
    expect(kvi.y).toBe(nvi.y);
    expect([kvi.height, nvi.height]).toEqual([16, 16]);
    expect(nvi.x + nvi.width).toBeLessThanOrEqual((await box(row(page, code).locator("[data-cell]").first())).x);
  }
  expect((await box(badge(page, LONG, "krx"))).width).toBe((await box(badge(page, SAMSUNG, "krx"))).width);
  expect((await box(badge(page, LONG, "nxt"))).width).toBe((await box(badge(page, SAMSUNG, "nxt"))).width);
  expect(await nameText(page, LONG).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect((await box(row(page, LONG))).height).toBe(height);
});
