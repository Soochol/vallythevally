import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const ICHIMOKU_FOR_30_MINUTE_BARS = { kind: "ichimoku", conversion: 3, base: 5, spanB: 8, displacement: 6 };

async function seedLayout(app: App, period: string, indicators: object[], panels: object[]) {
  const current: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const { id, name, arrangement, sync, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels };
  const body = { id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol: "005930", venue: "combined", period, symbolLink: false, chartSettings }] };
  const r = await fetch(`${app.url}/api/layouts/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.ok).toBe(true);
}

const series = (page: Page) => page.evaluate(() => window.frameProbe.snapshot());

async function trade(app: App, page: Page, delivered: number[], price: number, time: string) {
  expect(await app.fake.pushReal("0B", "005930_AL", {
    "20": time, "10": `+${price}`, "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2",
  })).toBeGreaterThan(0);
  await expect.poll(() => delivered.includes(price), { timeout: 2000 }).toBe(true);
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(price), { timeout: 2000 });
}

test("후행스팬이 있는 칸에서 체결을 흘려도 모든 선의 update는 그 선의 마지막 점만 바꾼다", async ({ page, app }) => {
  const errors: string[] = [];
  const delivered: number[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const m = JSON.parse(String(payload));
    if (m.type === "bar" || m.type === "confirmed") delivered.push(m.bar.c);
  }));
  await seedLayout(app, "1m", [{ id: "i1", spec: ICHIMOKU_FOR_30_MINUTE_BARS, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }], []);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const row = page.locator('[data-indicator-row="i1"]');
  await expect(row).toContainText("일목균형표 3 5 8 6");
  await expect.poll(async () => (await series(page)).filter((s) => s.type === "Line" && s.data.length > 0).length).toBe(5);

  await expect(async () => {
    await trade(app, page, delivered, 201_000, "100031");
  }).toPass({ timeout: 15_000 });
  for (const [i, p] of [201_500, 200_500, 202_000].entries()) await trade(app, page, delivered, p, `10004${i}`);
  const barsBefore = Number(await chartOf(cell(page)).getAttribute("data-bar-count"));
  await expect(async () => {
    await trade(app, page, delivered, 203_000, "100101");
  }).toPass({ timeout: 45_000 });
  await trade(app, page, delivered, 203_500, "100102");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(barsBefore + 1));

  const snap = await series(page);
  const main = snap.find((s) => s.type === "Candlestick")!;
  const lastMain = Number(main.data.at(-1)!.time);
  const lines = snap.filter((s) => s.type === "Line");
  expect(lines).toHaveLength(5);
  for (const line of lines) {
    const times = line.updates.map((u) => Number(u.time));
    expect(times.length).toBeGreaterThan(0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.at(-1)).toBe(Number(line.data.at(-1)!.time));
  }
  const ends = lines.map((l) => Number(l.data.at(-1)!.time));
  expect(ends.filter((t) => t > lastMain)).toHaveLength(2);
  expect(ends.filter((t) => t === lastMain)).toHaveLength(2);
  expect(ends.filter((t) => t < lastMain)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("열기만 하면 v1 차트 설정을 서버에 쓰지 않고, 기본 거래량 지표를 보인다", async ({ page, app }) => {
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/api/layouts/")) puts.push(r.url());
  });
  const saved: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  expect(saved.cells[0]!.chartSettings).toMatchObject({ v: 1, indicators: [] });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-indicator-row]")).toHaveCount(1);
  await expect(page.locator("[data-indicator-row]")).toContainText("거래량");
  await page.waitForTimeout(2500);
  expect(puts).toEqual([]);
  const after: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  expect(after.revision).toBe(saved.revision);
});

test("첫 화면에서 봉과 거래량 막대가 같은 프레임에 그려진다", async ({ page }) => {
  await page.addInitScript(installFrameProbe);
  await page.addInitScript(() => {
    const frames: { main: number; volume: number }[] = [];
    (window as unknown as { frames_: typeof frames }).frames_ = frames;
    const tick = () => {
      const s = window.frameProbe?.snapshot() ?? [];
      frames.push({
        main: s.find((x) => x.type === "Candlestick")?.data.length ?? 0,
        volume: s.find((x) => x.type === "Histogram")?.data.length ?? 0,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => (window as unknown as { frames_: { volume: number }[] }).frames_.some((f) => f.volume > 0))).toBe(true);
  const frames = await page.evaluate(() => (window as unknown as { frames_: { main: number; volume: number }[] }).frames_);
  const firstMain = frames.findIndex((f) => f.main > 0);
  const firstVolume = frames.findIndex((f) => f.volume > 0);
  test.info().annotations.push({ type: "frames", description: `main ${firstMain}, volume ${firstVolume}` });
  expect(firstVolume - firstMain).toBe(0);
});
