import type { Page } from "@playwright/test";
import { type Scenario, expect, pollSaved, test } from "./harness";
import { BASE, cellAt, chipAt, openOrder, openOrderWindow, ordersOn, status, tradingApi, win, writesTo } from "./order-window";

const THREE = () => [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 69_900, 3), openOrder("0000003", "sell", 70_100, 4)];
const ROUTE_LABEL = { combined: "SOR", krx: "KRX", nxt: "NXT" } as const;
const CLOCK_START = new Date("2026-11-18T10:00:00+09:00");

const placeRequests = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/trading/commands/place" && r.method() === "POST");
const commandWrites = (scenario: Scenario) => scenario.requests.filter((r) => new URL(r.url()).pathname.startsWith("/api/trading/commands/") && r.method() === "POST");
const openBlankMenu = async (page: Page) => {
  await page.getByTestId("price-ladder").locator(".mw-px").first().click({ button: "right" });
  return page.getByRole("menu", { name: "주문 취소" });
};

test("여러 건을 한 번에 취소하는 줄은 처음 누르면 건수와 한 번 더 누르기를 보이고 요청이 없다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  const menu = await openBlankMenu(page);
  await menu.getByRole("menuitem", { name: "전체 모두 취소" }).click();
  await expect(menu.getByRole("menuitem", { name: "전체 3건 취소 · 한 번 더 누르기" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "매수 모두 취소" })).toBeVisible();
  expect(commandWrites(scenario)).toHaveLength(0);
  expect(api.writes).toHaveLength(0);
});

test("한 번 더 누르면 취소 요청이 가격과 방향마다 세 건 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  const menu = await openBlankMenu(page);
  await menu.getByRole("menuitem", { name: "전체 모두 취소" }).click();
  await menu.getByRole("menuitem", { name: "전체 3건 취소 · 한 번 더 누르기" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(3);
  expect(writesTo(api, "cancel-batch").map((w) => `${w.body.side}:${w.body.price}`).sort()).toEqual(["buy:69900", "buy:70000", "sell:70100"]);
  await expect(menu).toHaveCount(0);
});

test("한 번 누르고 3초가 지나면 원래 줄로 돌아가고 요청이 없다", async ({ page, scenario }) => {
  await page.clock.install({ time: CLOCK_START });
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  await page.clock.pauseAt(new Date("2026-11-18T10:05:00+09:00"));
  const menu = await openBlankMenu(page);
  await menu.getByRole("menuitem", { name: "전체 모두 취소" }).click();
  await expect(menu.getByRole("menuitem", { name: "전체 3건 취소 · 한 번 더 누르기" })).toBeVisible();
  await page.clock.fastForward(2_900);
  await expect(menu.getByRole("menuitem", { name: "전체 3건 취소 · 한 번 더 누르기" })).toBeVisible();
  await page.clock.fastForward(300);
  await expect(menu.getByRole("menuitem", { name: "전체 모두 취소" })).toBeVisible();
  expect(api.writes).toHaveLength(0);
  expect(commandWrites(scenario)).toHaveLength(0);
});

test("주문 한 건의 칩 메뉴 취소는 한 번에 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  await page.getByRole("menu", { name: "주문 목록" }).getByRole("menuitem", { name: "5 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel")).toHaveLength(1);
  expect(writesTo(api, "cancel")[0]!.body).toMatchObject({ orderNo: "0000001" });
});

test("한 건뿐인 가격의 이 가격 모두 취소도 한 번에 나가고 두 건이면 두 번 눌러야 한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 70_000, 5), openOrder("0000002", "buy", 70_000, 7), openOrder("0000003", "sell", 70_100, 4)]);
  await openOrderWindow(page, scenario);
  await chipAt(page, "sell", 70_100).click({ button: "right" });
  await page.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(1);
  await chipAt(page, "buy", 70_000).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "주문 목록" });
  await menu.getByRole("menuitem", { name: "이 가격 모두 취소" }).click();
  await expect(menu.getByRole("menuitem", { name: "이 가격 2건 취소 · 한 번 더 누르기" })).toBeVisible();
  expect(writesTo(api, "cancel-batch")).toHaveLength(1);
  await menu.getByRole("menuitem", { name: "이 가격 2건 취소 · 한 번 더 누르기" }).click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
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

test("여러 주문을 가진 합계 칸을 사다리 밖에 놓으면 상태 줄에 확인이 뜨고 눌러야 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario, THREE());
  await openOrderWindow(page, scenario);
  const total = page.getByTestId("order-total-buy");
  const box = (await total.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y - 10, { steps: 3 });
  await page.mouse.move(5, 5, { steps: 8 });
  await page.mouse.up();
  const confirm = page.getByTestId("order-cancel-confirm");
  await expect(confirm).toHaveText("매수 2건 취소 · 한 번 더 누르기");
  expect(api.writes).toHaveLength(0);
  await confirm.click();
  await pollSaved(() => writesTo(api, "cancel-batch")).toHaveLength(2);
  await expect(confirm).toHaveCount(0);
});
