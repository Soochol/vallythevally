import type { Page } from "@playwright/test";
import type { Quote } from "../src/api/generated/Quote";
import { type Scenario, expect, pollSaved, test } from "./harness";

test.use({ clockStart: "20261109100000" });

type Frame = { computedOffset: number; color?: string };
type Recorded = { frames: Frame[]; duration: unknown };
type Recorder = { tickAnimations: Recorded[] };

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const quote = (price: number, change: number, changeRate: number): Quote => ({ symbol: "005930", price, change, changeRate, volume: 1_300_000, t: 1794186000, source: "realtime", venue: "combined" });

function putWatchlist(scenario: Scenario) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => i === 0 ? { ...list, symbols: ["005930"] } : list), revision: current.revision + 1 });
  scenario.reply("/api/quotes", { body: [quote(50_000, -1000, -1.96)] });
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as Recorder).tickAnimations);
const tokenColor = (page: Page, token: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);

async function expectTick(page: Page, animation: Recorded, token: "--up" | "--down") {
  const resolved = await tokenColor(page, token);
  const isToken = (color: string | undefined) => color === `var(${token})` || (color !== undefined && color.trim() === resolved);
  expect(animation.duration).toBe(140);
  const start = animation.frames.find((frame) => frame.computedOffset === 0);
  expect(isToken(start?.color)).toBe(true);
  const end = animation.frames.find((frame) => frame.computedOffset === 1);
  expect(isToken(end?.color)).toBe(false);
}

test("값 바뀜 강조는 바뀐 방향의 색에서 시작해 --dur 동안 풀린다", async ({ page, scenario }) => {
  putWatchlist(scenario);
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    const seen: Recorded[] = [];
    (window as unknown as Recorder).tickAnimations = seen;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const animation = original.call(this, keyframes, options);
      const effect = animation.effect as KeyframeEffect | null;
      if (effect && this.closest('[data-cell="price"]')) seen.push({ frames: effect.getKeyframes().map((frame) => ({ computedOffset: frame.computedOffset, color: typeof frame.color === "string" ? frame.color : undefined })), duration: effect.getTiming().duration });
      return animation;
    };
  });
  await page.goto("/?symbol=005930");
  const button = row(page, "005930").locator("[data-main]");
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
  await pollSaved(() => scenario.live.subscriptions().some((value) => value.symbol === "005930")).toBe(true);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quote(51_500, 500, 0.98)] });
  await expect(button).toHaveAccessibleName("삼성전자 51,500 +0.98%");
  await expect.poll(async () => (await recorded(page)).length).toBe(1);
  await expectTick(page, (await recorded(page))[0]!, "--up");
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quote(49_800, -1200, -2.35)] });
  await expect(button).toHaveAccessibleName("삼성전자 49,800 −2.35%");
  await expect.poll(async () => (await recorded(page)).length).toBe(2);
  await expectTick(page, (await recorded(page))[1]!, "--down");
});
