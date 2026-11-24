import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { expect, pollSaved, type Scenario, test } from "./harness";
import { cellAt, center, chipAt, CODE, openOrder, openOrderWindow, ordersOn, SETTINGS, status, tradingApi, win, writesTo, type Api } from "./order-window";

test.use({ clockStart: "20261123140000" });

const MIDNIGHT = Date.parse("2026-11-23T00:00:00+09:00") / 1000;
const at = (hour: number, minute: number) => MIDNIGHT + hour * 3600 + minute * 60;

const BARS: Bar[] = Array.from({ length: 30 }, (_, i) => ({ t: at(8, 30 + i * 5), o: 70_000, h: 70_300, l: 69_800, c: 70_100, v: 1_000 }));

const DAY: BookReplayDay = {
  symbol: CODE,
  date: "20261123",
  coverage: "collected",
  covered: [[540, 560], [570, 620]],
  books: [
    {
      minute: 540,
      asks: Array.from({ length: 10 }, (_, i): [number, number] => [70_300 + i * 100, 100 + i]),
      bids: Array.from({ length: 10 }, (_, i): [number, number] => [70_200 - i * 100, 200 + i]),
      totalAsk: 1_234,
      totalBid: 2_345,
    },
  ],
  trades: [[540, 32_410, 70_200, -15], [540, 32_420, 70_300, 25]],
};

async function open(page: Page, scenario: Scenario, orderable?: { amount: number; cashAmount: number }): Promise<Api> {
  await page.addInitScript(installChartProbe);
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12)]);
  if (orderable) api.orderable = orderable;
  scenario.reply((url) => url.pathname === "/api/bars", { body: { symbol: CODE, venue: "combined", period: "5m", bars: BARS, current: null, nextBefore: at(8, 25), seq: null } });
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: DAY });
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, (windows) =>
    windows.map((window) => (window.kind === "chart" ? { ...window, period: "5m" as const, chartSettings: { ...SETTINGS, visibleBars: 40 } } : window)));
  await expect(chipAt(page, "buy", 70_000)).toBeVisible();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true }).click();
  return api;
}

async function barPoint(page: Page, time: number): Promise<{ x: number; y: number }> {
  return page.evaluate((time) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    if (!probe) throw new Error("차트 좌표가 없습니다");
    const x = probe.chart.timeScale().timeToCoordinate(time);
    const box = probe.chart.chartElement().getBoundingClientRect();
    if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.5 };
  }, toChartTime(time));
}

async function pointAt(page: Page, time: number): Promise<void> {
  const point = await barPoint(page, time);
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("과거 호가 동안 전체호가는 꺼진 상태로 비활성이 되고 호가 복기를 끄면 전 상태로 돌아온다", async ({ page, scenario }) => {
  await open(page, scenario);
  const explorer = win(page).getByTestId("order-explorer");
  await explorer.click();
  await expect(explorer).toHaveAttribute("aria-pressed", "true");
  await expect(win(page).getByTestId("order-ladder")).toHaveAttribute("data-explorer", "");

  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(explorer).toBeDisabled();
  await expect(explorer).toHaveAttribute("aria-pressed", "false");
  await expect(win(page).getByTestId("order-ladder")).not.toHaveAttribute("data-explorer");

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true }).click();
  await expect(win(page)).not.toHaveAttribute("data-replay");
  await expect(explorer).toBeEnabled();
  await expect(explorer).toHaveAttribute("aria-pressed", "true");
  await expect(win(page).getByTestId("order-ladder")).toHaveAttribute("data-explorer", "");
});

test("과거 호가 동안 사다리 우클릭 취소는 비활성이고 계좌 미체결 목록의 취소는 동작한다", async ({ page, scenario }) => {
  const api = await open(page, scenario);
  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");

  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toBeDisabled();
  await expect(items.nth(1)).toBeDisabled();
  await page.keyboard.press("Escape");

  await win(page).getByTestId("account-tab-open").click();
  const openPanel = page.getByTestId("account-open-order");
  await expect(openPanel).toHaveCount(1);
  await openPanel.getByRole("button", { name: "취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(api.writes).toHaveLength(1);
});

test("상태 막대의 보내기 단추도 과거 호가로 바뀐 뒤 누르면 주문을 보내지 않는다", async ({ page, scenario }) => {
  const api = await open(page, scenario, { amount: 350_000, cashAmount: 350_000 });
  await cellAt(page, "buy", 70_100).dblclick();
  const sendAction = page.getByTestId("order-status-action");
  await expect(sendAction).toBeVisible();
  expect(api.writes).toEqual([]);

  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await sendAction.click();
  await expect(status(page)).toContainText("과거 호가를 보는 동안에는 주문할 수 없습니다");
  expect(api.writes).toEqual([]);
});

test("사다리 칩을 끌던 중에 과거 호가로 바뀌면 놓아도 정정이나 취소가 나가지 않는다", async ({ page, scenario }) => {
  const api = await open(page, scenario);
  const from = await center(chipAt(page, "buy", 70_000));
  const bar = await barPoint(page, at(9, 0));

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y, { steps: 3 });
  await page.mouse.move(bar.x, bar.y, { steps: 5 });
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await page.mouse.up();

  await expect(status(page)).toContainText("과거 호가를 보는 동안에는 주문할 수 없습니다");
  expect(api.writes).toEqual([]);
});
