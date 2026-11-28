import type { Page } from "@playwright/test";
import type { QuoteDepthPage } from "../src/api/generated/QuoteDepthPage";
import type { QuoteDepthSource } from "../src/api/generated/QuoteDepthSource";
import { formatPrice, formatVolume } from "../src/lib/format";
import { cell, expect, test } from "./harness";

async function countHeatmapPixels(page: Page): Promise<{ ask: number; bid: number }> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const probe = document.createElement("canvas").getContext("2d")!;
    const rgbOf = (css: string): [number, number, number] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const data = probe.getImageData(0, 0, 1, 1).data;
      return [data[0]!, data[1]!, data[2]!];
    };
    const bg = rgbOf(style.getPropertyValue("--chart-bg").trim());
    const askRgb = rgbOf(style.getPropertyValue("--down").trim());
    const bidRgb = rgbOf(style.getPropertyValue("--up").trim());
    const blend = (c: [number, number, number], a: number): [number, number, number] => [
      Math.round(c[0] * a + bg[0] * (1 - a)),
      Math.round(c[1] * a + bg[1] * (1 - a)),
      Math.round(c[2] * a + bg[2] * (1 - a)),
    ];
    const askBlended = blend(askRgb, 0.7);
    const bidBlended = blend(bidRgb, 0.7);
    const near = (r: number, g: number, b: number, target: [number, number, number]) =>
      Math.abs(r - target[0]) <= 28 && Math.abs(g - target[1]) <= 28 && Math.abs(b - target[2]) <= 28;
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>("[data-bar-count] canvas")].filter(
      (c) => c.width > 120 && c.height > 120,
    );
    let ask = 0;
    let bid = 0;
    for (const canvas of canvases) {
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! === 0) continue;
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        if (near(r, g, b, askBlended)) ask++;
        else if (near(r, g, b, bidBlended)) bid++;
      }
    }
    return { ask, bid };
  });
}

test("히트맵을 더하면 값이 보이고 기준을 바꾸면 그 기준으로 다시 받는다", async ({ page, scenario }) => {
  const sample = scenario.market.page({ symbol: "005930", period: "5m", venue: "combined" });
  const bars = sample.current ? [...sample.bars, sample.current] : sample.bars;
  const lastBar = bars[bars.length - 1]!;
  const requested: { symbol: string; period: string; source: string }[] = [];

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/quote-depth$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const period = url.searchParams.get("period") ?? "";
      const source = (url.searchParams.get("source") ?? "priceMax") as QuoteDepthSource;
      const to = url.searchParams.get("to") ?? "2026-11-09";
      requested.push({ symbol, period, source });
      const askQty = source === "close" ? 3_210 : 9_000;
      const bidQty = source === "close" ? 5_432 : 12_345;
      const body: QuoteDepthPage = {
        available: true,
        venue: "combined",
        source,
        days: [{ date: to, state: "closed" }],
        points: bars.map((b) => ({
          t: b.t,
          asks: [[b.c + 100, askQty], [b.c + 200, Math.round(askQty / 2)]],
          bids: [[b.c - 100, bidQty], [b.c - 200, Math.round(bidQty / 2)]],
        })),
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=5m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const baseline = await countHeatmapPixels(page);

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "호가 잔량 히트맵", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const heatRow = page.locator("[data-indicator-row]").filter({ hasText: "호가 잔량 히트맵" });
  await expect(heatRow).toHaveCount(1);
  await expect(heatRow).toContainText(`${formatPrice(lastBar.c + 100, false)} ${formatVolume(9_000)}`);
  await expect(heatRow).toContainText(`${formatPrice(lastBar.c - 100, false)} ${formatVolume(12_345)}`);
  expect(requested.some((r) => r.symbol === "005930" && r.period === "5m" && r.source === "priceMax")).toBe(true);

  await expect.poll(async () => {
    const now = await countHeatmapPixels(page);
    return now.ask > baseline.ask + 100 && now.bid > baseline.bid + 100;
  }).toBe(true);

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 설정", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "차트 설정", exact: true });
  await settings.getByRole("group", { name: "봉 모양" }).getByRole("button", { name: "라인", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect.poll(async () => {
    const now = await countHeatmapPixels(page);
    return now.ask > baseline.ask + 100 && now.bid > baseline.bid + 100;
  }).toBe(true);

  await heatRow.getByRole("button", { name: "호가 잔량 히트맵 설정 열기", exact: true }).click();
  await dialog.getByRole("group", { name: "잔량 기준" }).getByRole("button", { name: "종가 호가", exact: true }).click();
  await dialog.getByRole("button", { name: "설정 닫기", exact: true }).click();
  await page.mouse.move(0, 0);

  await expect(heatRow).toContainText(`${formatPrice(lastBar.c + 100, false)} ${formatVolume(3_210)}`);
  await expect(heatRow).toContainText(`${formatPrice(lastBar.c - 100, false)} ${formatVolume(5_432)}`);
  expect(requested.some((r) => r.symbol === "005930" && r.period === "5m" && r.source === "close")).toBe(true);

  const periods = page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
  await periods.getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(heatRow).toHaveCount(0);
  expect(requested.filter((r) => r.period === "D")).toEqual([]);

  await periods.getByRole("button", { name: "분봉", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(heatRow).toHaveCount(1);
  await expect(heatRow).toContainText(`${formatPrice(lastBar.c + 100, false)} ${formatVolume(3_210)}`);
  await expect(heatRow).toContainText(`${formatPrice(lastBar.c - 100, false)} ${formatVolume(5_432)}`);
});
