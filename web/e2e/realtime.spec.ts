import type { Locator } from "@playwright/test";
import { type App, cell, chartOf, expect, test } from "./harness";

const MONDAY_1000_KST_DURING_MARKET_HOURS = "20261109100000";
test.use({ clockStart: MONDAY_1000_KST_DURING_MARKET_HOURS });

const kst = (iso: string) => Date.parse(`${iso}+09:00`) / 1000;
const NOV9 = kst("2026-11-09T00:00:00");
const AT_1000 = kst("2026-11-09T10:00:00");

function trade(hhmmss: string, price: number, qty: number): Record<string, string> {
  return { "20": hhmmss, "10": `+${price}`, "15": `+${qty}`, "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" };
}

async function waitRegistered(app: App, item: string) {
  await expect.poll(async () => (await app.fake.registered())["0B"] ?? [], { message: `${item} REG` }).toContain(item);
}

async function pushUntilApplied(app: App, chart: Locator, values: Record<string, string>, want: { t: number; close: number; count: number }) {
  await expect(async () => {
    await app.fake.pushReal("0B", "005930_AL", values);
    expect(await lastBar(chart)).toEqual(want);
  }).toPass({ timeout: 15_000 });
}

async function lastBar(chart: Locator) {
  const [t, close, count] = await Promise.all(["data-last-bar-t", "data-last-close", "data-bar-count"].map((a) => chart.getAttribute(a)));
  return { t: Number(t), close: Number(close), count: Number(count) };
}

test("체결마다 일봉 현재 봉이 움직이고, 키움 강제 단절 뒤에도 이어진다", async ({ page, app }) => {
  await page.goto("/?symbol=005930");
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await waitRegistered(app, "005930_AL");
  const before = await lastBar(chart);
  expect(before.t).toBeLessThan(NOV9);

  await pushUntilApplied(app, chart, trade("100001", 201_000, 10), { t: NOV9, close: 201_000, count: before.count + 1 });
  await app.fake.pushReal("0B", "005930_AL", trade("100002", 201_500, 5));
  await expect.poll(() => lastBar(chart)).toEqual({ t: NOV9, close: 201_500, count: before.count + 1 });

  await app.fake.dropWs(1000, "Bye");
  await expect(page.getByRole("contentinfo")).toContainText("키움에 다시 연결하는 중");
  await waitRegistered(app, "005930_AL");
  await expect(page.getByRole("contentinfo")).not.toContainText("다시 연결하는 중");

  await pushUntilApplied(app, chart, trade("100003", 202_000, 7), { t: NOV9, close: 202_000, count: before.count + 1 });
});

test("분봉은 다음 분 체결에서 봉이 확정되고 새 현재 봉이 붙는다", async ({ page, app }) => {
  await page.goto("/?symbol=005930&period=1m");
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await waitRegistered(app, "005930_AL");
  const before = await lastBar(chart);

  await pushUntilApplied(app, chart, trade("100001", 201_000, 10), { t: AT_1000, close: 201_000, count: before.count + 1 });
  await app.fake.pushReal("0B", "005930_AL", trade("100100", 200_500, 3));
  await expect.poll(() => lastBar(chart)).toEqual({ t: AT_1000 + 60, close: 200_500, count: before.count + 2 });
});

test("다시 구성한 세션에서도 REG가 거절되면 실시간만 멈추고 조회 차트는 그대로 쓴다", async ({ page, app }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await waitRegistered(app, "005930_AL");

  await app.fake.setRegLimit(0);
  await app.fake.dropWs(1000, "Bye");
  await expect(page.getByRole("contentinfo")).toContainText("실시간 멈춤: 서버를 다시 켜야 합니다", { timeout: 15_000 });

  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
  await expect(page.getByRole("contentinfo")).toContainText("실시간 멈춤: 서버를 다시 켜야 합니다");
});
