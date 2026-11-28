import type { QuoteTotalsPage } from "../src/api/generated/QuoteTotalsPage";
import { formatVolume } from "../src/lib/format";
import { cell, expect, test } from "./harness";

test("총잔량을 더하면 분봉에 매도·매수 값이 보이고 일봉에서는 사라진다", async ({ page, scenario }) => {
  const sample = scenario.market.page({ symbol: "005930", period: "5m", venue: "combined" });
  const bars = sample.current ? [...sample.bars, sample.current] : sample.bars;
  const ask = 61_287;
  const bid = 110_859;
  const requested: { symbol: string; period: string }[] = [];

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/quote-totals$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const period = url.searchParams.get("period") ?? "";
      const to = url.searchParams.get("to") ?? "2026-11-09";
      requested.push({ symbol, period });
      if (symbol === "005930") {
        const body: QuoteTotalsPage = {
          available: true,
          venue: "combined",
          days: [{ date: to, state: "closed" }],
          points: bars.map((b) => ({ t: b.t, ask, bid })),
        };
        return { body };
      }
      const body: QuoteTotalsPage = {
        available: true,
        venue: "combined",
        days: [{ date: to, state: "notCollected" }],
        points: [],
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=5m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "총잔량", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const totalsRow = page.locator("[data-indicator-row]").filter({ hasText: "총잔량" });
  await expect(totalsRow).toHaveCount(1);
  await totalsRow.locator("[data-indicator-edit]").click();
  await expect(page.getByRole("dialog", { name: "총잔량 설정", exact: true })).toContainText("주식·ETF 분봉의 호가 자료입니다");
  await page.keyboard.press("Escape");
  await expect(totalsRow).toContainText(formatVolume(ask));
  await expect(totalsRow).toContainText(formatVolume(bid));

  const periods = page.getByRole("toolbar").getByRole("group", { name: "봉 주기" });
  await periods.getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(totalsRow).toHaveCount(0);
  expect(requested.filter((r) => r.period === "D")).toEqual([]);

  await periods.getByRole("button", { name: "분봉", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(totalsRow).toHaveCount(1);
  await expect(totalsRow).toContainText(formatVolume(ask));
  await expect(totalsRow).toContainText(formatVolume(bid));

  await page.getByRole("button", { name: "종목·지표·명령 찾기" }).click();
  const searchBox = page.getByRole("dialog").getByRole("combobox");
  await searchBox.fill("000660");
  await page.getByRole("dialog").getByRole("option").filter({ hasText: "000660" }).first().click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(totalsRow).toContainText("수집하지 않는 종목");
});

test("서버에 호가 자료 폴더가 없으면 수집 폴더 미설정 안내를 보인다", async ({ page, scenario }) => {
  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/quote-totals$/.test(url.pathname),
    (request) => {
      const to = new URL(request.url()).searchParams.get("to") ?? "2026-11-09";
      const body: QuoteTotalsPage = { available: false, venue: "combined", days: [{ date: to, state: "none" }], points: [] };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=5m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "총잔량", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const totalsRow = page.locator("[data-indicator-row]").filter({ hasText: "총잔량" });
  await expect(totalsRow).toHaveCount(1);
  await expect(totalsRow).toContainText("수집 폴더 미설정");
});
