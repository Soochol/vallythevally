import type { Page } from "@playwright/test";
import type { Bar } from "../src/api/generated/Bar";
import type { BookReplayDay } from "../src/api/generated/BookReplayDay";
import { toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, expect, pickDesktopVenue, pollSaved, type Scenario, test } from "./harness";
import { cellAt, center, chipAt, CODE, dragChip, openOrder, openOrderWindow, ordersOn, SETTINGS, status, tradingApi, win, writesTo, type Api } from "./order-window";

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

async function open(page: Page, scenario: Scenario): Promise<Api> {
  await page.addInitScript(installChartProbe);
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12)]);
  scenario.reply((url) => url.pathname === "/api/bars", { body: { symbol: CODE, venue: "combined", period: "5m", bars: BARS, current: null, nextBefore: at(8, 25), seq: null } });
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: DAY });
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, (windows) =>
    windows.map((window) => (window.kind === "chart" ? { ...window, period: "5m" as const, chartSettings: { ...SETTINGS, visibleBars: 40 } } : window)));
  await expect(chipAt(page, "buy", 70_000)).toBeVisible();
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true }).click();
  return api;
}

async function pointAt(page: Page, time: number): Promise<void> {
  const point = await page.evaluate((time) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    if (!probe) throw new Error("차트 좌표가 없습니다");
    const x = probe.chart.timeScale().timeToCoordinate(time);
    const box = probe.chart.chartElement().getBoundingClientRect();
    if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.5 };
  }, toChartTime(time));
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("호가 복기 동안 호가주문창은 그 봉의 호가를 보이고 주문 칸을 잠근다", async ({ page, scenario }) => {
  const api = await open(page, scenario);
  const slot = win(page).getByTestId("order-status-slot");
  const ladderBefore = (await win(page).getByTestId("order-ladder").boundingBox())!;
  await expect(slot.getByTestId("replay-strip")).toHaveText("실시간 · 차트를 가리키면 그 시각 호가");
  await expect(cellAt(page, "buy", 70_000)).not.toHaveAttribute("data-disabled");

  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(slot.getByTestId("replay-strip")).toContainText("수집 호가 · 11/23 09:04:59");
  await expect(slot.getByTestId("replay-strip")).toContainText("주문 잠금");
  const ladderDuring = (await win(page).getByTestId("order-ladder").boundingBox())!;
  expect(Math.abs(ladderDuring.y - ladderBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(ladderDuring.height - ladderBefore.height)).toBeLessThanOrEqual(1);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("1,234");
  await expect(win(page).getByTestId("order-total-bid")).toHaveText("2,345");
  await expect(win(page).getByTestId("order-symbol-price")).toHaveText("70,300");
  await expect(win(page).getByTestId("ladder-trade")).toHaveCount(2);
  await expect(win(page).getByTestId("ladder-info-card")).toHaveCount(0);

  await cellAt(page, "sell", 70_500).hover();
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(cellAt(page, "sell", 70_500)).toHaveAttribute("data-disabled", "");
  await expect(cellAt(page, "sell", 70_500).getByTestId("order-preview")).toHaveCount(0);
  await cellAt(page, "sell", 70_500).dblclick();
  await cellAt(page, "buy", 70_100).dblclick();
  await expect(cellAt(page, "buy", 70_000)).toHaveAttribute("data-disabled", "");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 70_200)));
  expect(api.writes).toEqual([]);

  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true }).click();
  await expect(win(page)).not.toHaveAttribute("data-replay");
  await expect(win(page).getByTestId("replay-strip")).toHaveCount(0);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("1,000");
  await cellAt(page, "buy", 70_100).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: 70_100, quantity: 10 });
});

test("과거 호가를 보는 동안 미체결 합계에서 끌어 온 주문을 사다리에 놓아도 정정하지 않는다", async ({ page, scenario }) => {
  const api = await open(page, scenario);
  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");

  await win(page).getByTestId("order-total-buy").click();
  const row = page.getByTestId("order-list-row");
  await expect(row).toHaveCount(1);
  await dragChip(page, row, await center(cellAt(page, "buy", 70_200)));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(page.getByTestId("order-status")).toContainText("과거 호가를 보는 동안에는 주문할 수 없습니다");
  expect(writesTo(api, "modify")).toEqual([]);

  if (await row.count() === 0) await win(page).getByTestId("order-total-buy").click();
  await row.getByRole("menuitem").click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(api.writes).toHaveLength(1);
});

test("수집 호가가 없는 봉이면 호가주문창 사다리를 비운다", async ({ page, scenario }) => {
  const api = await open(page, scenario);
  await pointAt(page, at(9, 25));
  await expect(win(page)).toHaveAttribute("data-replay", "none");
  await expect(win(page).getByTestId("replay-strip")).toHaveText("수집이 끊긴 시각입니다");
  await expect(win(page).getByTestId("price-ladder")).toHaveCount(0);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("-");
  await expect(win(page).getByTestId("order-total-bid")).toHaveText("-");
  await expect(win(page).getByTestId("order-symbol-price")).toHaveText("-");
  expect(api.writes).toEqual([]);
  await expect(cell(page)).toBeVisible();
});

test.describe("호가 복기 주문 추가", () => {
  const extraOpen = async (page: Page, scenario: Scenario, orderable?: { amount: number; cashAmount: number }): Promise<Api> => {
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
  };

  const extraBarPoint = async (page: Page, time: number): Promise<{ x: number; y: number }> =>
    page.evaluate((t) => {
      const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
      if (!probe) throw new Error("차트 좌표가 없습니다");
      const x = probe.chart.timeScale().timeToCoordinate(t);
      const box = probe.chart.chartElement().getBoundingClientRect();
      if (x === null || x < 0 || x > probe.chart.timeScale().width()) throw new Error("가리킬 봉이 화면 밖입니다");
      return { x: box.x + x, y: box.y + box.height * 0.5 };
    }, toChartTime(time));

  test("과거 호가 동안 전체호가는 꺼진 상태로 비활성이 되고 호가 복기를 끄면 전 상태로 돌아온다", async ({ page, scenario }) => {
    await extraOpen(page, scenario);
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
    const api = await extraOpen(page, scenario);
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
    const api = await extraOpen(page, scenario, { amount: 350_000, cashAmount: 350_000 });
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
    const api = await extraOpen(page, scenario);
    const from = await center(chipAt(page, "buy", 70_000));
    const bar = await extraBarPoint(page, at(9, 0));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12, from.y, { steps: 3 });
    await page.mouse.move(bar.x, bar.y, { steps: 5 });
    await expect(win(page)).toHaveAttribute("data-replay", "past");
    await page.mouse.up();

    await expect(status(page)).toContainText("과거 호가를 보는 동안에는 주문할 수 없습니다");
    expect(api.writes).toEqual([]);
  });

  test("앱 거래소가 KRX일 때 복기 막대 오른쪽에 통합과 주문 잠금이 나란히 보인다", async ({ page, scenario }) => {
    await extraOpen(page, scenario);
    await pickDesktopVenue(page, "KRX");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");

    await pointAt(page, at(9, 0));
    await expect(win(page)).toHaveAttribute("data-replay", "past");
    const strip = win(page).getByTestId("replay-strip");
    const venue = win(page).getByTestId("replay-venue");
    const lock = strip.locator(".od-replay-lock");
    await expect(venue).toHaveText("통합");
    await expect(lock).toHaveText("주문 잠금");

    const stripBox = await strip.boundingBox();
    const venueBox = await venue.boundingBox();
    const lockBox = await lock.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(venueBox).not.toBeNull();
    expect(lockBox).not.toBeNull();
    expect(lockBox!.x).toBeGreaterThanOrEqual(venueBox!.x + venueBox!.width);
    expect(lockBox!.x - (venueBox!.x + venueBox!.width)).toBeLessThan(20);
    expect(stripBox!.x + stripBox!.width - (lockBox!.x + lockBox!.width)).toBeLessThan(24);
  });
});
