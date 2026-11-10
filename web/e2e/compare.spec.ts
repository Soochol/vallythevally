import type { Locator, Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installFrameProbe } from "./frame-probe";
import { type App, cell, chartOf, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

async function layoutOf(app: App): Promise<Layout> {
  return (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
}

const settingsOf = async (app: App) => (await layoutOf(app)).cells[0]!.chartSettings as { scale: string; compare: string[] };

const VOLUME = { id: "v1", spec: { kind: "volume", maPeriod: null }, panel: "p1", visible: true, style: { colors: ["ind-1"], width: 1 } };

async function seed(app: App, over: { compare?: string[]; scale?: string; indicators?: object[]; panels?: object[] } = {}, period = "1m") {
  const { id, name, arrangement, sync, revision } = await layoutOf(app);
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], ...over };
  const body = { id, name, arrangement, sync, revision: revision + 1, cells: [{ slot: 0, symbol: "005930", venue: "combined", period, symbolLink: false, chartSettings }] };
  const r = await fetch(`${app.url}/api/layouts/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.ok).toBe(true);
}

const rows = (page: Page) => cell(page).locator("[data-compare-row]");
const row = (page: Page, code: string) => cell(page).locator(`[data-compare-row="${code}"]`);

interface Sent {
  type: string;
  sub?: string;
  symbol?: string;
}

function sentFrames(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => sent.push(JSON.parse(String(payload)))));
  return sent;
}

const tradeValues = (price: number, time: string) => ({
  "20": time, "10": `+${price}`, "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2",
});

async function openCompareTab(page: Page): Promise<Locator> {
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "비교 종목" }).click();
  return dialog;
}

async function addCompare(dialog: Locator, name: string) {
  await dialog.getByRole("combobox", { name: "비교할 종목 찾기" }).fill(name);
  await dialog.getByRole("option", { name: new RegExp(name) }).first().click();
  await dialog.getByRole("button", { name: new RegExp(`^${name}.*추가$`) }).click();
}

test("비교 종목 탭에서 3개까지 넣고 4번째는 막히며, 빼면 그 구독을 풀고, 새로고침해도 남는다", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const sent = sentFrames(page);
  await seed(app);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  await expect(chart).toHaveAttribute("data-price-scale", "normal");

  const dialog = await openCompareTab(page);
  for (const name of ["삼성SDI", "삼성화재", "코스피"]) await addCompare(dialog, name);
  await expect(rows(page)).toHaveCount(3);
  await expect(dialog).toContainText("비교 종목 3/3");
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  for (const code of ["006400", "000810", "IDX:001"]) await expect(row(page, code)).not.toHaveAttribute("data-last-t", "");

  await dialog.getByRole("combobox", { name: "비교할 종목 찾기" }).fill("삼성물산");
  await dialog.getByRole("option", { name: /삼성물산/ }).first().click();
  await expect(dialog.getByRole("button", { name: /^삼성물산.*추가$/ })).toBeDisabled();
  await expect(dialog).toContainText("비교 종목은 3개까지입니다");

  const subOf = (symbol: string) => sent.find((m) => m.type === "subscribe" && m.symbol === symbol)?.sub;
  await expect.poll(() => ["006400", "000810", "IDX:001"].map((s) => subOf(s) !== undefined)).toEqual([true, true, true]);
  await expect.poll(async () => (await settingsOf(app)).compare).toEqual(["006400", "000810", "IDX:001"]);

  await dialog.getByRole("button", { name: "삼성화재 지우기" }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => sent.some((m) => m.type === "unsubscribe" && m.sub === subOf("000810"))).toBe(true);
  await expect.poll(async () => (await settingsOf(app)).compare).toEqual(["006400", "IDX:001"]);

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rows(page)).toHaveCount(2);
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
  expect(errors).toEqual([]);
});

test("% 축은 비교 종목 없이도 켜고 끄며, 비교 종목이 있는 동안은 %로 고정되고 다 빼면 저장된 축으로 돌아간다", async ({ page, app }) => {
  await seed(app);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));
  const pct = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "%", exact: true });
  const log = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "로그", exact: true });

  await pct.click();
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await expect.poll(async () => (await settingsOf(app)).scale).toBe("percent");
  await pct.click();
  await expect(chart).toHaveAttribute("data-price-scale", "normal");
  await log.click();
  await expect(chart).toHaveAttribute("data-price-scale", "log");

  const dialog = await openCompareTab(page);
  await addCompare(dialog, "삼성SDI");
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await expect(pct).toBeDisabled();
  await expect(log).toBeDisabled();
  await expect(dialog.getByRole("switch", { name: "가격축을 % 변화로" })).toBeDisabled();
  await expect.poll(async () => (await settingsOf(app)).scale).toBe("log");

  await dialog.getByRole("button", { name: "삼성SDI 지우기" }).click();
  await expect(chart).toHaveAttribute("data-price-scale", "log");
  await dialog.getByRole("switch", { name: "가격축을 % 변화로" }).click();
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await expect.poll(async () => (await settingsOf(app)).scale).toBe("percent");
});

test("비교 종목도 체결마다 움직인다", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await seed(app, { compare: ["006400"] });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "006400")).not.toHaveAttribute("data-last-t", "");
  await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toEqual(expect.arrayContaining(["005930_AL", "006400_AL"]));

  const chart = chartOf(cell(page));
  await expect(async () => {
    expect(await app.fake.pushReal("0B", "005930_AL", tradeValues(201_000, "100031"))).toBeGreaterThan(0);
    await expect(chart).toHaveAttribute("data-last-close", "201000", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const minute = await chart.getAttribute("data-last-bar-t");

  await expect(async () => {
    expect(await app.fake.pushReal("0B", "006400_AL", tradeValues(55_500, "100032"))).toBeGreaterThan(0);
    await expect(row(page, "006400")).toHaveAttribute("data-last-close", "55500", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(row(page, "006400")).toHaveAttribute("data-last-t", minute!);
  expect(await app.fake.pushReal("0B", "006400_AL", tradeValues(56_000, "100033"))).toBeGreaterThan(0);
  await expect(row(page, "006400")).toHaveAttribute("data-last-close", "56000");
  await expect(row(page, "006400")).toHaveAttribute("data-last-t", minute!);
  expect(errors).toEqual([]);
});

test("일반 축에서 그린 드로잉은 % 축이 되고 스크롤로 기준 봉이 바뀌어도 주 봉 시리즈의 가격 좌표에 붙어 있다", async ({ page, app }) => {
  await seed(app, {}, "D");
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const chart = chartOf(cell(page));

  const box = (await chart.boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.86, box.y + box.height * 0.3, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await (await fetch(`${app.url}/api/drawings?symbol=005930`)).json()).length).toBe(1);
  const [drawing] = await (await fetch(`${app.url}/api/drawings?symbol=005930`)).json();
  const prices: number[] = drawing.points.map((p: { price: number }) => p.price);

  const mirror = cell(page).locator(".drawing-mirror[data-drawings]");
  const drawnY = async () => {
    const items = JSON.parse((await mirror.getAttribute("data-drawings"))!) as { points: ({ y: number } | null)[] }[];
    return items[0]!.points.map((p) => p?.y ?? null);
  };
  const candleY = () => page.evaluate((ps) => ps.map((p) => window.frameProbe.candleY(p)), prices);
  const onCandles = async () => {
    const [d, c] = [await drawnY(), await candleY()];
    return d.every((y, i) => y !== null && c[i] !== null && Math.abs(y - c[i]!) < 0.5);
  };
  await expect.poll(onCandles).toBe(true);
  const before = await drawnY();

  const dialog = await openCompareTab(page);
  await addCompare(dialog, "코스피");
  await page.keyboard.press("Escape");
  await expect(chart).toHaveAttribute("data-price-scale", "percent");
  await expect(row(page, "IDX:001")).not.toHaveAttribute("data-last-t", "");
  await expect.poll(onCandles).toBe(true);
  const inPercent = await drawnY();

  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await drawnY())[0]).not.toBe(inPercent[0]);
  await expect.poll(onCandles).toBe(true);
  expect(await (await fetch(`${app.url}/api/drawings?symbol=005930`)).json()).toHaveLength(1);
  console.log("DRAWING_Y", JSON.stringify({ normal: before, percent: inPercent, afterScroll: await drawnY() }));
});

test("비교 종목이 저장된 칸을 열어도 지표 패널 축은 % 축이 아니다", async ({ page, app }) => {
  await seed(app, { compare: ["IDX:001"], indicators: [VOLUME], panels: [{ id: "p1", stretch: 0.25 }] }, "D");
  await page.addInitScript(installFrameProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "percent");
  const modes = async () => {
    const snap = await page.evaluate(() => window.frameProbe.snapshot());
    return { main: snap.find((s) => s.type === "Candlestick")?.scaleMode, volume: snap.find((s) => s.type === "Histogram")?.scaleMode };
  };
  await expect.poll(modes).toEqual({ main: 2, volume: 0 });

  await openCompareTab(page);
  await page.getByRole("dialog").getByRole("button", { name: "코스피 지우기" }).click();
  await page.keyboard.press("Escape");
  await expect(chartOf(cell(page))).toHaveAttribute("data-price-scale", "normal");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "로그", exact: true }).click();
  await expect.poll(modes).toEqual({ main: 1, volume: 0 });
});
