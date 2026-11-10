import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installFrameProbe } from "./frame-probe";
import { type App, barTimes, cell, chartOf, DEFAULT_LAYOUT_ID, dragTowardPast, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const ICHIMOKU_FOR_30_MINUTE_BARS = { kind: "ichimoku", conversion: 3, base: 5, spanB: 8, displacement: 6 };

async function seedLayout(app: App, period: string, indicators: object[], panels: object[], symbol = "005930") {
  const current: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const { id, name, arrangement, sync, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels };
  const body = { id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol, venue: "combined", period, symbolLink: false, chartSettings }] };
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
  await expect.poll(async () => (await series(page)).filter((s) => s.type === "Custom" && s.data.length > 0).length).toBe(5);

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
  const lines = snap.filter((s) => s.type === "Custom");
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

test("첫 화면에서 거래량 막대는 봉보다 많아야 한 프레임 늦게 그려진다", async ({ page }) => {
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
  expect(firstVolume - firstMain).toBeGreaterThanOrEqual(0);
  expect(firstVolume - firstMain).toBeLessThanOrEqual(1);
});

const ma = (id: string, period: number) => ({ id, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } });

test("설정값이 틀린 지표는 그리지 않고 설정 오류를 남기며, 같은 칸의 다른 지표는 그린다", async ({ page, app }) => {
  await seedLayout(app, "D", [ma("bad", 0), ma("good", 5)], []);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-indicator-row="bad"]')).toContainText("설정 오류");
  await expect(page.locator('[data-indicator-row="good"]')).toContainText(/\d/);
  await expect(page.locator('[data-indicator-row="good"]')).not.toContainText("오류");
});

test("wasm을 받지 못하면 봉은 그대로 그리고 지표 범례에 계산 오류를 남긴다", async ({ page, app }) => {
  await seedLayout(app, "D", [ma("m", 5)], []);
  await page.context().route("**/*.wasm", (route) => route.abort());
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  await expect(page.locator('[data-indicator-row="m"]')).toContainText("계산 오류");
});

test("일목균형표를 띄운 채 과거로 스크롤해도 다가갈 때마다 과거 페이지는 하나다", async ({ page, app }) => {
  await seedLayout(app, "D", [{ id: "i1", spec: { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }], [], "086520");
  const older: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/bars") && r.url().includes("before=")) older.push(r.url());
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(page.locator('[data-indicator-row="i1"]')).toContainText(/\d/);
  await page.waitForTimeout(1000);
  expect(older).toEqual([]);
  const before = await barTimes(chart);
  await dragTowardPast(page, chart, async () => expect((await barTimes(chart)).count).toBeGreaterThan(before.count));
  await page.waitForTimeout(1500);
  expect(older).toHaveLength(1);
  await expect(page.locator('[data-indicator-row="i1"]')).toContainText(/\d/);
});

declare global {
  interface Window {
    workerReplies: number;
  }
}

function countWorkerReplies(): void {
  window.workerReplies = 0;
  const Base = window.Worker;
  window.Worker = class extends Base {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", () => {
        window.workerReplies++;
      });
    }
  };
}

test.describe("체결 없던 분 뒤", () => {
  test.use({ clockStart: "20261109100330" });

  test("선행스팬을 다시 놓은 프레임에 그 봉 확정과 다음 봉이 겹쳐도, 모든 선을 시각 순서대로 끝까지 그린다", async ({ page, app }) => {
    const errors: string[] = [];
    const delivered: number[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("지표")) errors.push(m.text());
    });
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      const m = JSON.parse(String(payload));
      if (m.type === "bar" || m.type === "confirmed") delivered.push(m.bar.c);
    }));
    const style = { colors: ["ind-1"], width: 1 };
    await seedLayout(app, "1m", [
      { id: "i1", spec: ICHIMOKU_FOR_30_MINUTE_BARS, panel: "price", visible: true, style },
      { id: "i2", spec: { kind: "bollinger", period: 20, k: 2 }, panel: "price", visible: true, style },
      { id: "i3", spec: { kind: "volume", maPeriod: 5 }, panel: "p1", visible: true, style },
    ], [{ id: "p1", stretch: 0.25 }]);
    await page.addInitScript(installFrameProbe);
    await page.addInitScript(countWorkerReplies);
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    const drawn = async () => {
      const snap = await series(page);
      const lastMain = Number(snap.find((s) => s.type === "Candlestick")!.data.at(-1)!.time);
      return { lastMain, lines: snap.filter((s) => s.type !== "Candlestick" && s.data.length > 0) };
    };
    await expect.poll(async () => (await drawn()).lines.length).toBe(10);
    const lagging = async () => {
      const { lastMain, lines } = await drawn();
      const behind = lines.filter((l) => Number(l.data.at(-1)!.time) < lastMain);
      return behind.map((l) => (l.data.at(-1) as { value: number }).value);
    };

    await expect(async () => {
      await trade(app, page, delivered, 201_000, "100031");
    }).toPass({ timeout: 15_000 });
    await expect.poll(lagging).toEqual([201_000]);

    await page.evaluate(() => window.frameProbe.hold());
    const repliesBefore = await page.evaluate(() => window.workerReplies);
    const deliveredBefore = delivered.length;
    for (const [price, time] of [[202_000, "100201"], [203_000, "100301"]] as const) {
      expect(await app.fake.pushReal("0B", "005930_AL", {
        "20": time, "10": `+${price}`, "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2",
      })).toBeGreaterThan(0);
      await expect.poll(() => delivered.includes(price)).toBe(true);
    }
    await expect.poll(async () => (await page.evaluate(() => window.workerReplies)) - repliesBefore).toBe(delivered.length - deliveredBefore);
    await page.evaluate(() => window.frameProbe.release());
    await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", "203000");

    expect(errors).toEqual([]);
    const { lastMain, lines } = await drawn();
    for (const line of lines) {
      const times = line.updates.map((u) => Number(u.time));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    const ends = lines.map((l) => Number(l.data.at(-1)!.time));
    const ahead = ends.filter((t) => t > lastMain);
    expect(ahead).toHaveLength(2);
    expect(ahead[0]).toBe(ahead[1]);
    expect(ends.filter((t) => t === lastMain)).toHaveLength(lines.length - 3);
    expect(await lagging()).toEqual([203_000]);
  });
});
