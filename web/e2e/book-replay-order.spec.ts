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
const LOCK_TEXT = "호가 복기를 해제해야 주문이 들어갑니다";

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

const replayToggle = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "호가 복기", exact: true });

async function openReady(page: Page, scenario: Scenario, options?: { orderable?: { amount: number; cashAmount: number }; replayOn?: boolean }): Promise<Api> {
  await page.addInitScript(installChartProbe);
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 12)]);
  if (options?.orderable) api.orderable = options.orderable;
  scenario.reply((url) => url.pathname === "/api/bars", { body: { symbol: CODE, venue: "combined", period: "5m", bars: BARS, current: null, nextBefore: at(8, 25), seq: null } });
  scenario.reply("/api/book-replay/access", { body: { available: true } });
  scenario.reply((url) => url.pathname === `/api/symbols/${CODE}/book-replay`, { body: DAY });
  await openOrderWindow(page, scenario, false, "krx", undefined, false, undefined, (windows) =>
    windows.map((window) => (window.kind === "chart" ? { ...window, period: "5m" as const, chartSettings: { ...SETTINGS, visibleBars: 40 } } : window)));
  await expect(chipAt(page, "buy", 70_000)).toBeVisible();
  if (options?.replayOn !== false) await replayToggle(page).click();
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

test("호가 복기 ON 직후와 과거 호가 동안 호가주문창은 세로 높이를 늘리지 않고 헤더 줄에 잠금을 보이며 외곽선 강조가 없다", async ({ page, scenario }) => {
  const api = await openReady(page, scenario, { replayOn: false });
  const slot = win(page).getByTestId("order-status-slot");
  const banner = win(page).getByTestId("order-replay-banner");
  const ladderBefore = (await win(page).getByTestId("order-ladder").boundingBox())!;
  const colheadBefore = (await win(page).getByTestId("order-colhead").boundingBox())!;

  await replayToggle(page).click();

  await expect(win(page)).toHaveAttribute("data-replay-locked", "");
  await expect(win(page)).not.toHaveAttribute("data-writable", "");
  await expect(banner).toBeVisible();
  await expect(win(page).getByTestId("order-colhead")).toHaveCount(0);
  await expect(banner).toContainText("호가 복기 중 · 주문 잠금");
  await expect(banner.getByTestId("order-replay-unlock")).toHaveText("호가 복기 해제");
  const ladderAfterOn = (await win(page).getByTestId("order-ladder").boundingBox())!;
  const bannerBox = (await banner.boundingBox())!;
  expect(Math.abs(ladderAfterOn.y - ladderBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(ladderAfterOn.height - ladderBefore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(bannerBox.y - colheadBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bannerBox.height - colheadBefore.height)).toBeLessThanOrEqual(1);
  expect(await win(page).evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  expect(await win(page).locator(".od-ladder-wrap").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  await expect(slot.getByTestId("replay-strip")).toContainText("실시간 · 차트를 가리키면 그 시각 호가");
  await expect(slot.getByTestId("replay-strip")).toContainText("주문 잠금");
  await expect(cellAt(page, "buy", 70_000)).toHaveAttribute("data-disabled", "");

  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  expect(await win(page).evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  expect(await win(page).locator(".od-ladder-wrap").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
  await expect(slot.getByTestId("replay-strip")).toContainText("수집 호가 · 11/23 09:04:59");
  await expect(slot.getByTestId("replay-strip")).toContainText("주문 잠금");
  const ladderDuring = (await win(page).getByTestId("order-ladder").boundingBox())!;
  expect(Math.abs(ladderDuring.y - ladderBefore.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(ladderDuring.height - ladderBefore.height)).toBeLessThanOrEqual(1);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("1,234");
  await expect(win(page).getByTestId("order-total-bid")).toHaveText("2,345");
  await expect(win(page).getByTestId("order-symbol-price")).toHaveCount(0);
  await expect(win(page).locator(".mw-lr[data-current] .mw-px-num")).toHaveText("70,300");
  await expect(win(page).getByTestId("ladder-trade")).toHaveCount(2);
  await expect(win(page).getByTestId("ladder-info-card")).toHaveCount(0);

  await cellAt(page, "sell", 70_500).hover();
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(cellAt(page, "sell", 70_500)).toHaveAttribute("data-disabled", "");
  await expect(cellAt(page, "sell", 70_500).getByTestId("order-preview")).toHaveCount(0);
  await cellAt(page, "sell", 70_500).dblclick();
  await expect(status(page)).toContainText(LOCK_TEXT);
  await cellAt(page, "buy", 70_100).dblclick();
  await expect(cellAt(page, "buy", 70_000)).toHaveAttribute("data-disabled", "");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 70_200)));
  expect(api.writes).toEqual([]);

  await replayToggle(page).click();
  await expect(win(page)).not.toHaveAttribute("data-replay");
  await expect(win(page)).not.toHaveAttribute("data-replay-locked");
  await expect(win(page)).toHaveAttribute("data-writable", "");
  await expect(banner).toHaveCount(0);
  await expect(win(page).getByTestId("replay-strip")).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("1,000");
  await cellAt(page, "buy", 70_100).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: 70_100, quantity: 10 });
});

test("호가 복기 ON 직후 차트를 가리키기 전에도 신규·정정·취소 전 경로가 즉시 차단된다", async ({ page, scenario }) => {
  const api = await openReady(page, scenario);
  await expect(win(page)).not.toHaveAttribute("data-replay");
  await expect(win(page)).toHaveAttribute("data-replay-locked", "");

  await cellAt(page, "buy", 70_100).hover();
  await expect(cellAt(page, "buy", 70_100).getByTestId("order-preview")).toHaveCount(0);
  await cellAt(page, "buy", 70_100).dblclick();
  await expect(status(page)).toContainText(LOCK_TEXT);
  await expect(status(page).getByTestId("order-status-action")).toHaveText("호가 복기 해제");

  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 70_200)));
  await dragChip(page, chipAt(page, "buy", 70_000), await center(win(page).getByTestId("order-account")));
  await expect(win(page)).not.toHaveAttribute("data-replay");

  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const chipMenu = page.getByRole("menu", { name: "주문 목록" });
  await expect(chipMenu.getByRole("menuitem").nth(0)).toBeDisabled();
  await expect(chipMenu.getByRole("menuitem").nth(1)).toBeDisabled();
  await page.keyboard.press("Escape");

  const totalBuy = win(page).getByTestId("order-total-buy");
  expect(await totalBuy.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("grab");
  await status(page).getByRole("button", { name: "닫기" }).click();
  await expect(status(page)).toHaveCount(0);
  await dragChip(page, totalBuy, await center(win(page).getByTestId("order-account")));
  await expect(status(page)).toContainText(LOCK_TEXT);

  await totalBuy.click();
  const totalMenu = page.getByRole("menu", { name: "매수 접수 주문" });
  const totalRow = totalMenu.getByTestId("order-list-row");
  await expect(totalRow.getByRole("menuitem", { name: "취소" })).toBeDisabled();
  await expect(totalMenu.getByRole("menuitem", { name: "매수 모두 취소" })).toBeDisabled();
  await dragChip(page, totalRow, await center(cellAt(page, "buy", 70_200)));
  await page.keyboard.press("Escape");

  await win(page).getByTestId("account-tab-open").click();
  const openRow = page.getByTestId("account-open-order");
  await expect(openRow.getByRole("button", { name: "취소" })).toBeDisabled();
  await expect(openRow.getByRole("button", { name: "취소" })).toHaveAttribute("title", LOCK_TEXT);
  expect(api.writes).toEqual([]);
});

test("잠금 배너와 상태 막대의 원클릭 호가 복기 해제 버튼으로 해제하면 즉시 주문이 들어간다", async ({ page, scenario }) => {
  const api = await openReady(page, scenario);

  await win(page).getByTestId("order-replay-unlock").click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(win(page).getByTestId("order-replay-banner")).toHaveCount(0);
  await expect(win(page)).toHaveAttribute("data-writable", "");
  await cellAt(page, "buy", 70_100).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);

  await replayToggle(page).click();
  await expect(win(page)).toHaveAttribute("data-replay-locked", "");
  await cellAt(page, "sell", 70_200).dblclick();
  await expect(status(page)).toContainText(LOCK_TEXT);
  expect(writesTo(api, "place")).toHaveLength(1);

  await status(page).getByTestId("order-status-action").click();
  await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(win(page).getByTestId("order-replay-banner")).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);

  await cellAt(page, "sell", 70_200).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(2);
  expect(writesTo(api, "place")[1]!.body).toMatchObject({ side: "sell", price: 70_200, quantity: 10 });
});

test("과거 호가를 보는 동안 미체결 합계 목록의 정정 드래그와 취소는 모두 차단된다", async ({ page, scenario }) => {
  const api = await openReady(page, scenario);
  await pointAt(page, at(9, 0));
  await expect(win(page)).toHaveAttribute("data-replay", "past");

  await win(page).getByTestId("order-total-buy").click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  const row = menu.getByTestId("order-list-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("menuitem", { name: "취소" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "매수 모두 취소" })).toBeDisabled();
  await dragChip(page, row, await center(cellAt(page, "buy", 70_200)));
  await expect(win(page)).toHaveAttribute("data-replay", "past");
  await expect(status(page)).toContainText(LOCK_TEXT);
  expect(api.writes).toEqual([]);
});

test("수집 호가가 없는 봉이면 호가주문창 사다리를 비우고 인라인 해제 배너를 유지한다", async ({ page, scenario }) => {
  const api = await openReady(page, scenario);
  await pointAt(page, at(9, 25));
  await expect(win(page)).toHaveAttribute("data-replay", "none");
  await expect(win(page).getByTestId("order-replay-banner")).toBeVisible();
  await expect(win(page).getByTestId("order-replay-unlock")).toBeVisible();
  await expect(win(page).getByTestId("replay-strip")).toHaveText("수집이 끊긴 시각입니다");
  await expect(win(page).getByTestId("price-ladder")).toHaveCount(0);
  await expect(win(page).getByTestId("order-total-ask")).toHaveText("-");
  await expect(win(page).getByTestId("order-total-bid")).toHaveText("-");
  await expect(win(page).getByTestId("order-symbol-price")).toHaveCount(0);
  expect(api.writes).toEqual([]);
  await expect(cell(page)).toBeVisible();
});

test.describe("호가 복기 주문 추가", () => {
  test("과거 호가 동안 전체호가는 꺼지고 호가 복기를 끄면 전 상태로 돌아온다", async ({ page, scenario }) => {
    await openReady(page, scenario, { replayOn: false });
    const explorer = win(page).getByTestId("order-explorer");
    await explorer.click();
    await expect(explorer).toHaveAttribute("aria-pressed", "true");
    await expect(win(page).getByTestId("order-ladder")).toHaveAttribute("data-explorer", "");

    await replayToggle(page).click();
    await expect(win(page).getByTestId("order-replay-banner")).toBeVisible();
    await expect(explorer).toHaveCount(0);

    await pointAt(page, at(9, 0));
    await expect(win(page)).toHaveAttribute("data-replay", "past");
    await expect(win(page).getByTestId("order-ladder")).not.toHaveAttribute("data-explorer");

    await replayToggle(page).click();
    await expect(win(page)).not.toHaveAttribute("data-replay");
    await expect(explorer).toBeEnabled();
    await expect(explorer).toHaveAttribute("aria-pressed", "true");
    await expect(win(page).getByTestId("order-ladder")).toHaveAttribute("data-explorer", "");
  });

  test("과거 호가 동안 사다리 우클릭 취소와 계좌 미체결 목록 취소가 모두 비활성이다", async ({ page, scenario }) => {
    const api = await openReady(page, scenario);
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
    await expect(openPanel.getByRole("button", { name: "취소" })).toBeDisabled();
    expect(api.writes).toEqual([]);
  });

  test("상태 막대의 보내기 단추도 호가 복기를 켠 뒤 누르면 차트를 가리키기 전에도 주문을 보내지 않는다", async ({ page, scenario }) => {
    const api = await openReady(page, scenario, { orderable: { amount: 350_000, cashAmount: 350_000 }, replayOn: false });
    await cellAt(page, "buy", 70_100).dblclick();
    const sendAction = page.getByTestId("order-status-action");
    await expect(sendAction).toBeVisible();
    expect(api.writes).toEqual([]);

    await replayToggle(page).click();
    await expect(win(page)).toHaveAttribute("data-replay-locked", "");
    await sendAction.click();
    await expect(status(page)).toContainText(LOCK_TEXT);
    expect(api.writes).toEqual([]);
  });

  test("503 실패 뒤 호가 복기를 켜면 상태 막대의 다시 보내기와 접수 직후 되돌리기가 모두 차단된다", async ({ page, scenario }) => {
    const api = await openReady(page, scenario, { replayOn: false });
    let failOnce = true;
    await page.route("**/api/trading/commands/place", (route) => {
      if (!failOnce) return route.fallback();
      failOnce = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } }) });
    });

    await cellAt(page, "buy", 70_100).dblclick();
    await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
    const retryButton = status(page).getByRole("button", { name: /다시 보내기/ });
    await expect(retryButton).toBeVisible();

    await replayToggle(page).click();
    await expect(win(page)).toHaveAttribute("data-replay-locked", "");
    await retryButton.click();
    await expect(status(page)).toContainText(LOCK_TEXT);
    expect(api.writes).toEqual([]);

    await win(page).getByTestId("order-replay-unlock").click();
    await cellAt(page, "buy", 70_100).dblclick();
    await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
    const undoButton = status(page).getByRole("button", { name: "되돌리기" });
    await expect(undoButton).toBeVisible();

    await replayToggle(page).click();
    await undoButton.click();
    await expect(status(page)).toContainText(LOCK_TEXT);
    expect(writesTo(api, "cancel")).toEqual([]);
  });

  test("첫 주문이 처리 중인 동안 줄 선 다음 주문도 호가 복기를 켜면 전송하지 않고 차단한다", async ({ page, scenario }) => {
    const api = await openReady(page, scenario, { replayOn: false });
    const firstPlace = scenario.hold((url, request) => url.pathname === "/api/trading/commands/place" && request.method() === "POST");

    await cellAt(page, "buy", 70_100).dblclick();
    await firstPlace.received;
    await cellAt(page, "buy", 70_200).dblclick();
    await expect(page.getByTestId("order-queue")).toHaveText("줄 서는 중 · 2건");

    await replayToggle(page).click();
    await expect(win(page)).toHaveAttribute("data-replay-locked", "");
    firstPlace.reply({ body: { commandId: "cmd-first", kind: "buy", state: "accepted", orderNo: "0000010", targetOrderNo: null, price: 70_100, quantity: 10, reason: null } });

    await expect(page.getByTestId("order-queue")).toHaveCount(0);
    await expect(status(page)).toContainText(LOCK_TEXT);
    const placePosts = scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST");
    expect(placePosts).toHaveLength(1);
    expect(writesTo(api, "place")).toHaveLength(0);
  });

  test("새로고침 뒤에도 호가 복기가 켜져 있으면 접근 확인 전부터 차트 미가리킴까지 주문이 잠긴다", async ({ page, scenario }) => {
    const api = await openReady(page, scenario);
    await pollSaved(() => scenario.documents.uiPrefs().bookReplay).toBe(true);

    const heldAccess = scenario.hold("/api/book-replay/access");
    await page.reload();
    await expect(win(page)).toBeVisible();
    await expect(cellAt(page, "buy", 70_100)).toBeVisible();
    await heldAccess.received;

    await expect(win(page)).toHaveAttribute("data-replay-locked", "");
    await expect(win(page).getByTestId("order-replay-banner")).toBeVisible();
    await expect(cellAt(page, "buy", 70_100)).toHaveAttribute("data-disabled", "");
    await cellAt(page, "buy", 70_100).dblclick();
    await expect(status(page)).toContainText(LOCK_TEXT);
    expect(api.writes).toEqual([]);

    heldAccess.reply({ body: { available: true } });
    await expect(replayToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(win(page)).toHaveAttribute("data-replay-locked", "");
    await cellAt(page, "buy", 70_100).dblclick();
    expect(api.writes).toEqual([]);
  });

  test("앱 거래소가 KRX일 때 복기 막대 오른쪽에 통합과 주문 잠금이 나란히 보인다", async ({ page, scenario }) => {
    await openReady(page, scenario);
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
