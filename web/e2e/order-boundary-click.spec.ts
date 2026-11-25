import { expect, pollSaved, test } from "./harness";
import { BASE, cellAt, openOrderWindow, ordersOn, tradingApi, writesTo } from "./order-window";

test("인접한 주문 칸 사이에 빈 틈이 없고 경계선 위에서도 손 모양 커서와 더블클릭 주문이 동작한다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);

  const upper = cellAt(page, "buy", BASE);
  const lower = cellAt(page, "buy", BASE - 100);
  const upperBox = (await upper.boundingBox())!;
  const lowerBox = (await lower.boundingBox())!;
  expect(Math.abs(lowerBox.y - (upperBox.y + upperBox.height))).toBeLessThanOrEqual(0.5);

  const x = upperBox.x + upperBox.width / 2;
  const boundaryY = lowerBox.y;
  await page.mouse.move(x, boundaryY);
  const cursor = await page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px, py);
    return element ? getComputedStyle(element).cursor : null;
  }, [x, boundaryY] as const);
  expect(cursor).toBe("pointer");

  await page.mouse.dblclick(x, boundaryY);
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect([BASE, BASE - 100]).toContain(writesTo(api, "place")[0]!.body.price);
  expect(writesTo(api, "place")[0]!.body.side).toBe("buy");
});

test("더블클릭 중 포인터가 경계를 넘어 이웃 가격 칸으로 이동해도 마지막 위치에 가까운 가격으로 주문이 나간다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);

  const upperBox = (await cellAt(page, "sell", BASE + 200).boundingBox())!;
  const lowerBox = (await cellAt(page, "sell", BASE + 100).boundingBox())!;
  const x = upperBox.x + upperBox.width / 2;
  const firstY = upperBox.y + upperBox.height - 1;
  const secondY = lowerBox.y + 1;

  await page.mouse.click(x, firstY);
  await page.mouse.click(x, secondY, { clickCount: 2 });

  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "sell", price: BASE + 100, quantity: 10 });
});

test("주문 칸 바깥 2px 경계를 더블클릭하면 가까운 가격으로 주문이 나가고 가운데 가격 열 더블클릭은 주문하지 않는다", async ({ page, scenario }) => {
  ordersOn(scenario);
  const api = tradingApi(scenario);
  await openOrderWindow(page, scenario);

  const buyBox = (await cellAt(page, "buy", BASE).boundingBox())!;
  await page.mouse.dblclick(buyBox.x + buyBox.width + 2, buyBox.y + buyBox.height / 2);
  await pollSaved(() => writesTo(api, "place")).toHaveLength(1);
  expect(writesTo(api, "place")[0]!.body).toMatchObject({ side: "buy", price: BASE, quantity: 10 });

  const priceBox = (await page.locator(".mw-lr[data-current] .mw-px").boundingBox())!;
  await page.mouse.dblclick(priceBox.x + priceBox.width / 2, priceBox.y + priceBox.height / 2);
  expect(writesTo(api, "place")).toHaveLength(1);
});
