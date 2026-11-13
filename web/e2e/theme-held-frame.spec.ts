import { november9BarAt } from "./fixtures/frames";
import { selectMinute } from "./select-option";
import type { Page } from "@playwright/test";
import { installFrameProbe } from "./frame-probe";
import { cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const tail = (page: Page) => page.evaluate(() => window.frameProbe.snapshot().map((s) => ({ ...s, data: s.data.slice(-2) })));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("lime dark keeps main and volume coherent when a held rollover frame resumes", async ({ page, scenario }, info) => {
  const errors: string[] = [];
  const delivered: number[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  scenario.live.observe(message => {

    if (message.type === "bar") delivered.push(message.bar.c);
  });
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await selectMinute(page.getByRole("button", { name: "분봉" }), "1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const trade = async (price: number, time: string, quantity: number, timeout = 15_000) => {
    await expect(async () => {
      const volume = price === 202_000 ? 3 : price === 204_000 ? 7 : quantity;
    expect(await scenario.live.update("005930", { t: Date.parse(`2026-11-09T${time.slice(0,2)}:${time.slice(2,4)}:00+09:00`) / 1000, o: price < 203_000 ? 201_000 : price < 205_000 ? 203_000 : 205_000, h: price, l: price < 203_000 ? 201_000 : price < 205_000 ? 203_000 : 205_000, c: price, v: volume })).toBeGreaterThan(0);
      await expect.poll(() => delivered.includes(price), { timeout: 1000 }).toBe(true);
    }).toPass({ timeout });
  };
  const lastBars = async () => {
    const s = await tail(page);
    return { main: s.find((x) => x.type === "Candlestick")!.data, volume: s.find((x) => x.type === "Histogram")!.data };
  };

  await trade(201_000, "100001", 1);
  await expect(chart).toHaveAttribute("data-last-close", "201000");
  await frames(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => window.frameProbe.hold());
  await trade(202_000, "100059", 2);
  scenario.live.bar("005930", november9BarAt("10:00", 202_000, 3), "confirmed");
  await trade(203_000, "100100", 3);
  await expect(page.getByRole("button", { name: "테마 바꾸기", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.frameProbe.release());
  await frames(page);
  await expect.poll(async () => (await lastBars()).volume.at(-1)).toMatchObject({ value: 3 });
  const themed = await lastBars();
  const released = await lastBars();

  await trade(204_000, "100101", 4);
  await frames(page);
  const sameMinute = await lastBars();
  const sameMinuteClose = await chart.getAttribute("data-last-close");
  scenario.live.bar("005930", november9BarAt("10:01", 204_000, 7), "confirmed");
  await trade(205_000, "100200", 5, 45_000);
  await frames(page);
  const nextMinute = await lastBars();

  const evidence = { themed, released, sameMinute, nextMinute, errors, delivered, sameMinuteClose, lastClose: await chart.getAttribute("data-last-close") };
  console.log("THEME_HELD_FRAME", JSON.stringify(evidence));
  await info.attach("theme-held-frame.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });

  expect.soft(errors).toEqual([]);
  expect.soft(themed.main.at(-1)).toMatchObject({ time: themed.volume.at(-1)!.time, close: 203_000 });
  expect.soft(themed.volume.slice(-2)).toEqual([expect.objectContaining({ value: 3 }), expect.objectContaining({ value: 3 })]);
  expect.soft(released.main.at(-1)).toMatchObject({ close: 203_000 });
  expect.soft(sameMinute.main.at(-1)).toMatchObject({ open: 203_000, high: 204_000, close: 204_000 });
  expect.soft(sameMinute.volume.at(-1)).toMatchObject({ value: 7 });
  expect.soft(sameMinuteClose).toBe("204000");
  expect.soft(nextMinute.main.slice(-2)).toEqual([
    expect.objectContaining({ close: 204_000 }), expect.objectContaining({ open: 205_000, close: 205_000 }),
  ]);
  expect.soft(nextMinute.volume.slice(-2)).toEqual([expect.objectContaining({ value: 7 }), expect.objectContaining({ value: 5 })]);
  expect.soft(nextMinute.main.map((b) => b.time)).toEqual(nextMinute.volume.map((b) => b.time));
  await expect(chart).toHaveAttribute("data-last-close", "205000", { timeout: 1000 });
});
