import { november9BarAt } from "./fixtures/frames";
import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installFrameProbe } from "./frame-probe";
import { parseChartSettings } from "../src/chart/settings";
import { type Scenario, barTimes, cell, chartOf, DEFAULT_LAYOUT_ID, dragTowardPast, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

const ICHIMOKU_FOR_30_MINUTE_BARS = { kind: "ichimoku", conversion: 3, base: 5, spanB: 8, displacement: 6 };

async function seedLayout(scenario: Scenario, period: NonNullable<Parameters<Scenario["market"]["page"]>[0]["period"]>, indicators: object[], panels: object[], symbol = "005930") {
  const current: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const { id, name, arrangement, sync, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels };
  const body: Parameters<Scenario["documents"]["saveLayout"]>[0] = { id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol, venue: "combined", period, symbolLink: false, chartSettings }] };
  scenario.documents.saveLayout(body);
  if (period === "1m") scenario.on("/api/bars", request => {
    const url = new URL(request.url());
    const data = scenario.market.page({ symbol, period, before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null });
    return { body: { ...data, bars: data.bars.filter(bar => bar.t < Date.parse("2026-11-09T10:00:00+09:00") / 1000), current: null } };
  });

}

const series = (page: Page) => page.evaluate(() => window.frameProbe.snapshot());

async function trade(scenario: Scenario, page: Page, delivered: number[], price: number, time: string) {
  expect(await scenario.live.update("005930", { t: Date.parse(`2026-11-09T${time.slice(0,2)}:${time.slice(2,4)}:00+09:00`) / 1000, c: price, o: price, h: price, l: price, v: 1000 })).toBeGreaterThan(0);
  await expect.poll(() => delivered.includes(price), { timeout: 2000 }).toBe(true);
  await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(price), { timeout: 2000 });
}

test("후행스팬이 있는 칸에서 체결을 흘려도 모든 선의 update는 그 선의 마지막 점만 바꾼다", async ({ page, scenario }) => {
  const errors: string[] = [];
  const delivered: number[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  scenario.live.observe(m => {

    if (m.type === "bar" || m.type === "confirmed") delivered.push(m.bar.c);
  });
  await seedLayout(scenario, "1m", [{ id: "i1", spec: ICHIMOKU_FOR_30_MINUTE_BARS, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }], []);
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const row = page.locator('[data-indicator-row="i1"]');
  await expect(row).toContainText("일목균형표 3 5 8 6");
  await expect.poll(async () => (await series(page)).filter((s) => s.type === "Custom" && s.data.length > 0).length).toBe(5);

  await expect(async () => {
    await trade(scenario, page, delivered, 201_000, "100031");
  }).toPass({ timeout: 15_000 });
  for (const [i, p] of [201_500, 200_500, 202_000].entries()) await trade(scenario, page, delivered, p, `10004${i}`);
  const barsBefore = Number(await chartOf(cell(page)).getAttribute("data-bar-count"));
  scenario.live.bar("005930", november9BarAt("10:00", 202_000), "confirmed");
  await expect(async () => {
    await trade(scenario, page, delivered, 203_000, "100101");
  }).toPass({ timeout: 45_000 });
  await trade(scenario, page, delivered, 203_500, "100102");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", String(barsBefore + 1));
  const beforeSameClose = delivered.length;
  await trade(scenario, page, delivered, 203_500, "100103");
  await expect.poll(() => delivered.length).toBeGreaterThan(beforeSameClose);
  const updatedLast = async () => (await series(page)).filter((s) => s.type === "Custom").map((l) => Number(l.updates.at(-1)?.time) === Number(l.data.at(-1)?.time));
  await expect.poll(updatedLast).toEqual([true, true, true, true, true]);

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

test("열기만 하면 v1 차트 설정을 서버에 쓰지 않고, 기본 거래량 지표를 보인다", async ({ page, scenario }) => {
  await page.clock.install();
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/api/layouts/")) puts.push(r.url());
  });
  const saved: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  expect(saved.cells[0]!.chartSettings).toMatchObject({ v: 1, indicators: [] });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("[data-indicator-row]")).toHaveCount(1);
  await expect(page.locator("[data-indicator-row]")).toContainText("거래량");
  await page.clock.runFor(2500);
  expect(puts).toEqual([]);
  const after: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  expect(after.revision).toBe(saved.revision);
});

for (const wasmDelay of [0, 80]) {
  const name = wasmDelay === 0 ? "첫 화면에서 거래량 막대는 봉보다 많아야 한 프레임 늦게 그려진다" : "WASM 응답이 늦어도 첫 화면의 기본 거래량은 봉보다 많아야 한 프레임 늦게 준비된다";
  test(name, async ({ page, scenario }) => {
    const saved = scenario.documents.layout(DEFAULT_LAYOUT_ID);
    scenario.documents.saveLayout({ ...saved, revision: saved.revision + 1, cells: saved.cells.map(c => ({ ...c, symbol: "005930", venue: "combined" })) });
    let wasmRequests = 0;
    if (wasmDelay > 0) await page.context().route("**/*.wasm", async route => {
      wasmRequests++;
      await new Promise(resolve => setTimeout(resolve, wasmDelay));
      await route.continue();
    });
    await page.addInitScript(installFrameProbe);
    await page.addInitScript(() => {
      const frames: Window["volumeFrames"] = [];
      window.volumeFrames = frames;
      const tick = () => {
        const s = window.frameProbe?.snapshot() ?? [];
        const main = s.find(x => x.type === "Candlestick")?.data ?? [];
        const last = main.at(-1);
        frames.push({
          main: main.length,
          volume: s.find(x => x.type === "Histogram")?.data.length ?? 0,
          lastClose: last && "close" in last ? last.close : null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => page.evaluate(() => window.volumeFrames.some(f => f.volume > 0))).toBe(true);
    if (wasmDelay > 0) await expect.poll(() => wasmRequests).toBeGreaterThan(0);
    const frames = await page.evaluate(() => window.volumeFrames);
    const symbols = scenario.requests.filter(r => new URL(r.url()).pathname === "/api/bars").map(r => new URL(r.url()).searchParams.get("symbol"));
    await test.info().attach("volume-frames", { body: JSON.stringify({ wasmDelay, frames, symbols }), contentType: "application/json" });
    expect(symbols.length).toBeGreaterThan(0);
    expect(new Set(symbols)).toEqual(new Set(["005930"]));
    expect(new Set(frames.filter(f => f.main > 0).map(f => f.lastClose)).size).toBe(1);
    const firstMain = frames.findIndex(f => f.main > 0);
    const firstVolume = frames.findIndex(f => f.volume > 0);
    test.info().annotations.push({ type: "frames", description: `main ${firstMain}, volume ${firstVolume}, gap ${firstVolume - firstMain}` });
    expect(firstMain).toBeGreaterThanOrEqual(0);
    expect(firstVolume - firstMain).toBeGreaterThanOrEqual(0);
    expect(firstVolume - firstMain).toBeLessThanOrEqual(1);
  });
}

const ma = (id: string, period: number) => ({ id, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } });

test("설정값이 틀린 지표는 그리지 않고 설정 오류를 남기며, 같은 칸의 다른 지표는 그린다", async ({ page, scenario }) => {
  await seedLayout(scenario, "D", [ma("bad", 0), ma("good", 5)], []);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-indicator-row="bad"]')).toContainText("설정 오류");
  await expect(page.locator('[data-indicator-row="good"]')).toContainText(/\d/);
  await expect(page.locator('[data-indicator-row="good"]')).not.toContainText("오류");
});

test("wasm을 받지 못해도 봉과 기본 거래량은 그리고 다른 지표 범례에 계산 오류를 남긴다", async ({ page, scenario }) => {
  await seedLayout(scenario, "D", [ma("m", 5), { id: "v", spec: { kind: "volume", maPeriod: null }, panel: "p", visible: true, style: { colors: ["ind-1"], width: 1 } }], [{ id: "p", stretch: 0.25 }]);
  await page.addInitScript(installFrameProbe);
  await page.context().route("**/*.wasm", (route) => route.abort());
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).not.toHaveAttribute("data-bar-count", "0");
  await expect(page.locator('[data-indicator-row="m"]')).toContainText("계산 오류");
  await expect(page.locator('[data-indicator-row="v"]')).not.toContainText("오류");
  await expect.poll(async () => (await series(page)).find(s => s.type === "Histogram")?.data.length ?? 0).toBeGreaterThan(0);
});

test("일목균형표를 띄운 채 과거로 스크롤해도 다가갈 때마다 과거 페이지는 하나다", async ({ page, scenario }) => {
  await page.clock.install();
  await seedLayout(scenario, "D", [{ id: "i1", spec: { kind: "ichimoku", conversion: 9, base: 26, spanB: 52, displacement: 26 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } }], [], "086520");
  const older: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/bars") && r.url().includes("before=")) older.push(r.url());
  });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(page.locator('[data-indicator-row="i1"]')).toContainText(/\d/);
  await page.clock.runFor(1000);
  expect(older).toEqual([]);
  const before = await barTimes(chart);
  await dragTowardPast(page, chart, async () => expect((await barTimes(chart)).count).toBeGreaterThan(before.count));
  await page.clock.runFor(1500);
  expect(older).toHaveLength(1);
  await expect(page.locator('[data-indicator-row="i1"]')).toContainText(/\d/);
});

test("이동평균선을 띄운 채 과거로 끌면 워커 응답 전에도 선이 남고, 응답 뒤에는 붙인 과거까지 그린다", async ({ page, scenario }) => {
  await page.clock.install();
  await seedLayout(scenario, "D", [ma("m", 5)], [], "086520");
  await page.addInitScript(installFrameProbe);
  await page.addInitScript(holdWorkerReplies);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  const row = page.locator('[data-indicator-row="m"]');
  const line = async () => (await series(page)).find((s) => s.type === "Custom")?.data.flatMap((d) => "value" in d ? [Number(d.time)] : []) ?? [];
  const price = /\d,\d{3}/;
  await expect(row).toContainText(price);
  await expect.poll(async () => (await line()).length).toBeGreaterThan(0);
  const firstBefore = (await line())[0]!;
  const before = await barTimes(chart);

  await page.evaluate(() => window.workerHold.start());
  await dragTowardPast(page, chart, async () => expect((await barTimes(chart)).count).toBeGreaterThan(before.count));
  await expect.poll(() => page.evaluate(() => window.workerHold.held())).toBeGreaterThan(0);
  expect((await line())[0]).toBe(firstBefore);
  expect(await row.innerText()).toMatch(price);

  await page.evaluate(() => window.workerHold.release());
  await expect.poll(async () => (await line())[0]).toBeLessThan(firstBefore);
  await expect(row).toContainText(price);
});

declare global {
  interface Window {
    workerReplies: number;
    workerHold: { start(): void; held(): number; release(): void };
    volumeFrames: { main: number; volume: number; lastClose: number | null }[];
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

function holdWorkerReplies(): void {
  const held: { worker: Worker; data: unknown }[] = [];
  const released = new WeakSet<MessageEvent>();
  let holding = false;
  window.workerHold = {
    start: () => { holding = true; },
    held: () => held.length,
    release: () => {
      holding = false;
      for (const { worker, data } of held.splice(0)) {
        const event = new MessageEvent("message", { data });
        released.add(event);
        worker.dispatchEvent(event);
      }
    },
  };
  const Base = window.Worker;
  window.Worker = class extends Base {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", (event) => {
        if (!holding || released.has(event)) return;
        event.stopImmediatePropagation();
        held.push({ worker: this, data: event.data });
      });
    }
  };
}

test.describe("체결 없던 분 뒤", () => {
  test.use({ clockStart: "20261109100330" });

  test("선행스팬을 다시 놓은 프레임에 그 봉 확정과 다음 봉이 겹쳐도, 모든 선을 시각 순서대로 끝까지 그린다", async ({ page, scenario }) => {
    const errors: string[] = [];
    const delivered: number[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().includes("지표")) errors.push(m.text());
    });
    scenario.live.observe(m => {

      if (m.type === "bar" || m.type === "confirmed") delivered.push(m.bar.c);
    });
    const style = { colors: ["ind-1"], width: 1 };
    await seedLayout(scenario, "1m", [
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
      await trade(scenario, page, delivered, 201_000, "100031");
    }).toPass({ timeout: 15_000 });
    await expect.poll(lagging).toEqual([201_000]);

    await page.evaluate(() => window.frameProbe.hold());
    const repliesBefore = await page.evaluate(() => window.workerReplies);
    const deliveredBefore = delivered.length;
    for (const [price, time, confirmedTime, confirmedPrice] of [[202_000, "100201", "10:00", 201_000], [203_000, "100301", "10:02", 202_000]] as const) {
      scenario.live.bar("005930", november9BarAt(confirmedTime, confirmedPrice), "confirmed");
      expect(await scenario.live.update("005930", { t: Date.parse(`2026-11-09T${time.slice(0,2)}:${time.slice(2,4)}:00+09:00`) / 1000, c: price, o: price, h: price, l: price, v: 1000 })).toBeGreaterThan(0);
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

test("지표 창에서 테마 색을 고르면 토큰을, 색상표의 색을 고르면 HEX를 저장하고 고친 색도 같은 규칙을 따른다", async ({ page, scenario }) => {
  const saved = async () => parseChartSettings(scenario.documents.layout(DEFAULT_LAYOUT_ID).cells[0]!.chartSettings).indicators.filter((i) => i.spec.kind === "ma").map((i) => i.style.colors);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창" });
  const input = dialog.getByRole("combobox", { name: "지표·비교 찾기" });
  const theme = dialog.getByRole("group", { name: "테마 색", exact: true });
  const table = dialog.getByRole("group", { name: "색상표", exact: true });
  await input.fill("이평 9");
  await expect(theme.getByRole("button", { name: /^테마 2 / })).toHaveAttribute("aria-pressed", "true");
  await theme.getByRole("button", { name: /^테마 4 / }).click();
  await expect(theme.getByRole("button", { name: /^테마 4 / })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("group", { name: "선 색상", exact: true })).toContainText("테마 4");
  await dialog.getByRole("button", { name: "이동평균 단순 9 추가", exact: true }).click();
  await expect.poll(saved).toEqual([["ind-4"]]);
  await input.fill("이평 11");
  await table.getByRole("button", { name: "진한 파랑 #4A7FE0", exact: true }).click();
  await expect(table.getByRole("button", { name: "진한 파랑 #4A7FE0", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(theme.getByRole("button", { pressed: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "이동평균 단순 11 추가", exact: true }).click();
  await expect.poll(saved).toEqual([["ind-4"], ["#4A7FE0"]]);

  await dialog.getByRole("tab", { name: /^이 칸에 띄운 지표/ }).click();
  await dialog.getByRole("button", { name: "이동평균 단순 9 설정", exact: true }).click();
  await expect(theme.getByRole("button", { name: /^테마 4 / })).toHaveAttribute("aria-pressed", "true");
  await table.getByRole("button", { name: "분홍 #EE9DD0", exact: true }).click();
  await dialog.getByRole("button", { name: "변경 적용", exact: true }).click();
  await expect.poll(saved).toEqual([["#EE9DD0"], ["#4A7FE0"]]);
  await dialog.getByRole("button", { name: "이동평균 단순 11 설정", exact: true }).click();
  await expect(table.getByRole("button", { name: "진한 파랑 #4A7FE0", exact: true })).toHaveAttribute("aria-pressed", "true");
  await theme.getByRole("button", { name: /^테마 1 / }).click();
  await dialog.getByRole("button", { name: "변경 적용", exact: true }).click();
  await expect.poll(saved).toEqual([["#EE9DD0"], ["ind-1"]]);
});
