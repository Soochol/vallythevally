import type { Locator, Page } from "@playwright/test";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, cellAt, center, chipAt, dragChip, openOrder, openOrderWindow, ordersOn, status, tradingApi, win, writesTo } from "./order-window";

const THREE = () => [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3), openOrder("0000003", "sell", 70_100, 4)];
const ROUTE_LABEL = { combined: "SOR", krx: "KRX", nxt: "NXT" } as const;
const CLOCK_START = new Date("2026-11-18T10:00:00+09:00");

const placeRequests = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST");
const commandWrites = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname.startsWith("/api/trading/commands/") && r.method() === "POST");

test("주문 한 건의 칩 메뉴 취소는 한 번에 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  await page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "5 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
});

test("한 건이든 두 건이든 이 가격 모두 취소는 한 번에 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "sell", 70_100).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ side: "sell", price: 70_100 });
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await menu.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
  expect(writesTo(api, "cancel-batch")[1]!.body).toMatchObject({ side: "buy", price: 70_000 });
  await expect(menu).toHaveCount(0);
});

test("접수 합계 목록에서 값 글자를 눌러도 취소되지 않고 취소 글자를 눌러야 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  const total = page.getByTestId("order-total-buy");
  await expect(total).toHaveText("8 (2)");
  await total.click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  const rows = menu.getByTestId("order-list-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("70,000원 · 5");
  await rows.first().getByText("70,000원 · 5").click();
  await expect(menu).toBeVisible();
  expect(commandWrites(scenario)).toHaveLength(0);
  expect(api.writes).toHaveLength(0);
  await rows.first().getByRole("menuitem", { name: "취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
});

test("1억원을 넘는 주문의 확인 상자에 종목 이름과 계좌 끝자리와 주문 경로가 보이고 확인 전 보내기 버튼은 다른 배경이다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  await page.getByLabel("수량", { exact: true }).fill("1429");
  await cellAt(page, "buy", 70_000).hover();
  await cellAt(page, "buy", 70_000).dblclick();
  const dialog = page.getByRole("dialog");
  const box = dialog.getByTestId("order-confirm");
  await expect(box).toContainText("삼성전자");
  await expect(box).toContainText("005930");
  await expect(box).toContainText("매수");
  await expect(box.getByTestId("order-confirm-amount")).toHaveText("100,030,000원");
  await expect(box.getByTestId("order-confirm-where")).toContainText("****-**01");
  const route = ROUTE_LABEL[(await win(page).getAttribute("data-venue")) as keyof typeof ROUTE_LABEL];
  await expect(box.getByTestId("order-confirm-where")).toContainText(`주문 경로 ${route}`);
  await expect(box.getByTestId("order-confirm-where")).toContainText("실전");
  const send = dialog.getByRole("button", { name: "매수 주문 보내기" });
  await expect(send).toBeDisabled();
  const background = () => send.evaluate((element) => getComputedStyle(element).backgroundColor);
  const before = await background();
  await dialog.getByRole("checkbox").check();
  await expect(send).toBeEnabled();
  await expect.poll(background).not.toBe(before);
  expect(writesTo(api, "place")).toHaveLength(0);
  await send.click();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ quantity: 1429, price: BASE, confirmHighValue: true });
});

test("주문이 거절되면 결과 막대가 닫을 때까지 남고 사다리 줄을 덮지 않는다", async ({ page, scenario }) => {
  await page.clock.install({ time: CLOCK_START });
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);
  api.placeReply = { state: "rejected", reason: "out_of_limit", orderNo: null };
  await cellAt(page, "sell", 70_300).dblclick();
  const bar = status(page);
  await expect(bar).toContainText("거절 · 상·하한가 범위를 벗어난 가격입니다");
  await page.clock.fastForward(60_000);
  await expect(bar).toBeVisible();
  const ladder = page.getByTestId("order-ladder");
  await ladder.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const lastRow = page.getByTestId("price-ladder").locator(".mw-lr").last();
  const barBox = (await bar.boundingBox())!;
  const rowBox = (await lastRow.boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y + 0.5);
  const ladderBox = (await ladder.boundingBox())!;
  expect(ladderBox.y + ladderBox.height).toBeLessThanOrEqual(barBox.y + 0.5);
  await bar.getByRole("button", { name: "닫기" }).click();
  await expect(bar).toHaveCount(0);
});

test("답 없음 막대의 다시 보내기는 같은 명령 번호로 요청을 다시 보낸다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario);
  await openOrderWindow(page, scenario);
  let failures = 1;
  await page.route("**/api/trading/commands/place", (route) => {
    if (failures <= 0) return route.fallback();
    failures -= 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "서버가 응답하지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } }) });
  });
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("서버의 답을 받지 못했습니다");
  await expect(placeRequests(scenario)).toHaveLength(1);
  await status(page).getByRole("button", { name: "다시 보내기" }).click();
  await pollSaved(() => placeRequests(scenario)).toHaveLength(2);
  const [first, second] = placeRequests(scenario).map((request) => String((request.postDataJSON() as Record<string, unknown>).commandId));
  expect(second).toBe(first);
  await expect(status(page)).toContainText("접수");
});

test("정정 고액 확인 상자의 주문 경로는 창의 경로가 아니라 원주문의 거래소를 보인다", async ({ page, scenario }) => {
  ordersOn(scenario);
  tradingApi(scenario, [{ ...openOrder("N-0001", "buy", 70_000, 1500), venue: "nxt" }]);
  await openOrderWindow(page, scenario);
  expect(await win(page).getAttribute("data-venue")).not.toBe("nxt");
  await dragChip(page, chipAt(page, "buy", 70_000), await center(cellAt(page, "buy", 69_900)));
  const where = page.getByRole("dialog").getByTestId("order-confirm-where");
  await expect(where).toContainText("주문 경로 NXT");
  await expect(page.getByRole("dialog").getByTestId("order-confirm")).toContainText("정정");
});

test("정정 직후 목록에 아직 없는 낙관적 주문이 든 가격도 끌어서 놓으면 그 가격 일괄 취소가 바로 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3)]);
  await openOrderWindow(page, scenario);
  await dragChip(page, chipAt(page, "buy", 69_900), await center(cellAt(page, "buy", 70_000)));
  await pollSaved(() => writesTo(api, "modify")).toHaveLength(1);
  await expect(chipAt(page, "buy", 70_000)).toContainText("8");
  await dragChip(page, chipAt(page, "buy", 70_000), { x: 5, y: 5 });
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  expect(writesTo(api, "cancel-batch")[0]!.body).toMatchObject({ side: "buy", price: 70_000 });
  await expect(status(page)).toContainText("취소 접수");
});

async function overlapPointInOrderCell(page: Page, item: Locator): Promise<{ pageX: number; pageY: number; position: { x: number; y: number } }> {
  const box = (await item.boundingBox())!;
  const hit = await page.evaluate(({ x, y, width, height }) => {
    for (const element of document.querySelectorAll<HTMLElement>("[data-order-cell]")) {
      const rect = element.getBoundingClientRect();
      const left = Math.max(x, rect.left);
      const right = Math.min(x + width, rect.right);
      const top = Math.max(y, rect.top);
      const bottom = Math.min(y + height, rect.bottom);
      if (right - left >= 4 && bottom - top >= 4) {
        const pageX = (left + right) / 2;
        const pageY = (top + bottom) / 2;
        return { pageX, pageY, position: { x: pageX - x, y: pageY - y } };
      }
    }
    return null;
  }, box);
  expect(hit).not.toBeNull();
  return hit!;
}

test("이 가격 모두 취소를 주문 칸 위에서 빠르게 두 번 눌러도 취소만 한 번 나가고 신규 주문은 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  const item = menu.getByRole("menuitem", { name: "이 가격 모두 취소" });
  const { position } = await overlapPointInOrderCell(page, item);
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await item.dblclick({ position });
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  expect(writesTo(api, "place")).toHaveLength(0);
  await expect(status(page)).toContainText("취소 접수");
});

test("빈 곳 우클릭의 전체 모두 취소를 주문 칸 위에서 빠르게 두 번 눌러도 취소만 한 번 나가고 신규 주문은 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  await cellAt(page, "sell", 70_300).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 취소" });
  const item = menu.getByRole("menuitem", { name: "전체 모두 취소" });
  const { position } = await overlapPointInOrderCell(page, item);
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await item.dblclick({ position });
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(3);
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  expect(writesTo(api, "place")).toHaveLength(0);
  await expect(status(page)).toContainText("취소 접수");
});

test("주문 한 건의 칩 메뉴 취소를 주문 칸 위에서 빠르게 두 번 눌러도 신규 주문은 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  const item = menu.getByRole("menuitem", { name: "5 취소" });
  const { position } = await overlapPointInOrderCell(page, item);
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await item.dblclick({ position });
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("이 가격 모두 취소를 주문 칸 위에서 빠르게 네 번 눌러도 취소만 한 번 나가고 신규 주문은 나가지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  const item = menu.getByRole("menuitem", { name: "이 가격 모두 취소" });
  const { pageX, pageY } = await overlapPointInOrderCell(page, item);
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await page.mouse.move(pageX, pageY);
  for (const clickCount of [1, 2, 3, 4]) {
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
  }
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  expect(writesTo(api, "place")).toHaveLength(0);
  await expect(status(page)).toContainText("취소 접수");
});

test("접수 합계 목록의 줄 취소를 빠르게 두 번 눌러도 취소만 한 번 나가고 뒤따르는 더블클릭이 전달되지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3)]);
  await openOrderWindow(page, scenario);
  await page.evaluate(() => {
    (window as unknown as { __dblclicks: number }).__dblclicks = 0;
    document.addEventListener("dblclick", () => {
      (window as unknown as { __dblclicks: number }).__dblclicks += 1;
    });
  });
  await page.getByTestId("order-total-buy").click();
  const menu = page.getByRole("menu", { name: "매수 접수 주문" });
  const item = menu.getByRole("menuitem", { name: "70,000원 · 5 취소" });
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await item.dblclick();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __dblclicks: number }).__dblclicks)).toBe(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  expect(writesTo(api, "place")).toHaveLength(0);
});

test("메뉴로 취소한 뒤 새로 더블클릭하면 신규 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  const item = menu.getByRole("menuitem", { name: "이 가격 모두 취소" });
  const { position } = await overlapPointInOrderCell(page, item);
  const refetched = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/open-orders");
  await item.dblclick({ position });
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  await refetched;
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("order-queue")).toHaveCount(0);
  expect(placeRequests(scenario)).toHaveLength(0);
  await cellAt(page, "sell", 70_300).dblclick();
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "sell", price: 70_300, quantity: 10 });
});
