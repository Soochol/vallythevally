import { november9BarAt } from "./fixtures/frames";
import { selectMinute } from "./select-option";
import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import { installFrameProbe } from "./frame-probe";
import { type Scenario, cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const series = (page: Page) => page.evaluate(() => window.frameProbe.snapshot());
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function savedDrawings(scenario: Scenario): Promise<Drawing[]> {
  return scenario.documents.drawings("005930");
}

const styleButton = (page: Page, label: string) =>
  page.getByRole("dialog", { name: "차트 설정", exact: true }).getByRole("group", { name: "봉 모양" }).getByRole("button", { name: label, exact: true });

async function styleMenu(page: Page) {
  if (!(await styleButton(page, "라인").isVisible())) await page.getByRole("button", { name: "차트 설정", exact: true }).click();
  await expect(styleButton(page, "라인")).toBeVisible();
}

test("replacement consumes queued rollover in both real series and retains newer queued ticks", async ({ page, scenario }, info) => {
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
  const box = (await chart.boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.86, box.y + box.height * 0.3, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => savedDrawings(scenario)).toHaveLength(1);
  const saved = (await savedDrawings(scenario))[0]!;
  await selectMinute(page.getByRole("button", { name: "분봉" }), "1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const trade = async (price: number, time: string, _quantity: number) => {
    const volume = price === 201_000 ? 1 : price === 202_000 ? 3 : price === 203_000 ? 3 : price === 204_000 ? 7 : price === 205_000 ? 12 : price === 206_000 ? 6 : 13;
    expect(await scenario.live.update("005930", { t: Date.parse(`2026-11-09T${time.slice(0,2)}:${time.slice(2,4)}:00+09:00`) / 1000, o: price < 203_000 ? 201_000 : price < 206_000 ? 203_000 : 206_000, h: price, l: price < 203_000 ? 201_000 : price < 206_000 ? 203_000 : 206_000, c: price, v: volume })).toBeGreaterThan(0);
    await expect.poll(() => delivered.includes(price), { timeout: 1000 }).toBe(true);
  };
  await expect(async () => {
    await trade(201_000, "100001", 1);
    await expect(chart).toHaveAttribute("data-last-close", "201000", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const lastVolume = async () => (await series(page)).find((s) => s.type === "Histogram")!.data.at(-1)!;
  await expect.poll(lastVolume).toMatchObject({ value: 1 });
  const initialVolume = await lastVolume();
  expect("value" in initialVolume).toBe(true);
  await styleMenu(page);
  await page.evaluate(() => window.frameProbe.hold());
  await trade(202_000, "100059", 2);
  scenario.live.bar("005930", november9BarAt("10:00", 202_000, 3), "confirmed");
  await trade(203_000, "100100", 3);
  await page.waitForTimeout(200);
  await styleButton(page, "라인").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  const snapshot = await series(page);
  expect(snapshot.map((s) => s.type).sort()).toEqual(["Histogram", "Line"]);
  const volume = snapshot.find((s) => s.type === "Histogram")!;
  const main = snapshot.find((s) => s.type === "Line")!;
  expect.soft(main.data.slice(-2)).toEqual([
    expect.objectContaining({ value: 202_000 }), expect.objectContaining({ value: 203_000 }),
  ]);
  expect.soft(volume.data.at(-1)).toMatchObject({ value: 3 });
  expect.soft(volume.data.at(-2)).toMatchObject({ value: "value" in initialVolume ? initialVolume.value + 2 : undefined });
  expect.soft(await chart.getAttribute("data-last-close")).toBe("203000");
  await trade(204_000, "100101", 4);
  await trade(205_000, "100102", 5);
  scenario.live.bar("005930", november9BarAt("10:01", 205_000, 12), "confirmed");
  await expect(() => trade(206_000, "100200", 6)).toPass({ timeout: 45_000 });
  await page.evaluate(() => window.frameProbe.release());
  await frames(page);
  const after = await series(page);
  console.log("ACTUAL_FRAME_SERIES", JSON.stringify({ snapshot: snapshot.map((s) => ({ ...s, data: s.data.slice(-2) })), after: after.map((s) => ({ ...s, data: s.data.slice(-2) })), errors, delivered }));
  await info.attach("actual-frame-series.json", { body: JSON.stringify({ snapshot, after, errors, delivered }), contentType: "application/json" });
  expect.soft(errors).toEqual([]);
  expect.soft(after.find((s) => s.type === "Line")!.data.slice(-2)).toEqual([
    expect.objectContaining({ value: 205_000 }), expect.objectContaining({ value: 206_000 }),
  ]);
  expect.soft(after.find((s) => s.type === "Histogram")!.data.slice(-2)).toEqual([
    expect.objectContaining({ value: 12 }), expect.objectContaining({ value: 6 }),
  ]);
  expect.soft(after.find((s) => s.type === "Line")!.updates).toHaveLength(2);
  expect.soft(after.find((s) => s.type === "Histogram")!.updates.length).toBe(volume.updates.length + 2);
  await expect(chart).toHaveAttribute("data-last-close", "206000", { timeout: 1000 });
  await expect(() => trade(207_000, "100201", 7)).toPass({ timeout: 15_000 });
  await expect(chart).toHaveAttribute("data-last-close", "207000");
  await expect.poll(async () => {
    const final = await series(page);
    return {
      main: final.find((s) => s.type === "Line")!.data.slice(-2),
      volume: final.find((s) => s.type === "Histogram")!.data.slice(-2),
    };
  }).toEqual({
    main: [expect.objectContaining({ value: 205_000 }), expect.objectContaining({ value: 207_000 })],
    volume: [expect.objectContaining({ value: 12 }), expect.objectContaining({ value: 13 })],
  });
  expect((await savedDrawings(scenario))[0]!.points).toEqual(saved.points);
  await page.keyboard.press("Escape");
  await expect(styleButton(page, "라인")).toBeHidden();
  await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => JSON.parse(await chart.locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]")).toEqual([
    expect.objectContaining({ id: saved.id, points: [expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }), expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })] }),
  ]);
  expect((await savedDrawings(scenario))[0]!.points).toEqual(saved.points);
  expect(errors).toEqual([]);
});

test("history-only snapshots remain identical across every main series style", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installFrameProbe);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => { const all = await series(page); return all.length === 2 && all.every((s) => s.data.length > 0); }).toBe(true);
  const before = await series(page);
  const history = before.find((s) => s.type === "Candlestick")!.data.map((b) => ({ time: b.time, value: "close" in b ? b.close : undefined }));
  expect(history.length).toBeGreaterThan(0);
  for (const [label, type] of [["라인", "Line"], ["영역", "Area"], ["바", "Bar"], ["캔들", "Candlestick"]] as const) {
    await styleMenu(page);
    await styleButton(page, label).click();
    const after = await series(page);
    expect(after.map((s) => s.type).sort()).toEqual(["Histogram", type].sort());
    expect(after.find((s) => s.type === type)!.data.map((b) => ({ time: b.time, value: "close" in b ? b.close : "value" in b ? b.value : undefined }))).toEqual(history);
    expect(after.find((s) => s.type === "Histogram")!.data).toEqual(before.find((s) => s.type === "Histogram")!.data);
  }
  expect(errors).toEqual([]);
});
