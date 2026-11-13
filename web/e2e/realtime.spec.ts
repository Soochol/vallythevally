import type { Bar } from "../src/api/generated/Bar";
import type { ServerMessage } from "../src/api/generated/ServerMessage";
import { cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });
const NOV9 = Date.parse("2026-11-09T00:00:00+09:00") / 1000;
const AT_1000 = Date.parse("2026-11-09T10:00:00+09:00") / 1000;
const bar = (t: number, c: number): Bar => ({ t, o: c, h: c, l: c, c, v: 1000 });

test("일봉 현재 봉과 재연결 상태를 표시하고 연결 회복 뒤 갱신을 이어간다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.live.subscriptions().some(value => value.symbol === "005930")).toBe(true);
  const count = Number(await chart.getAttribute("data-bar-count"));
  scenario.live.bar("005930", bar(NOV9, 201_000));
  await expect(chart).toHaveAttribute("data-last-close", "201000");
  scenario.live.bar("005930", bar(NOV9, 201_500));
  await expect(chart).toHaveAttribute("data-bar-count", String(count));
  await expect(chart).toHaveAttribute("data-last-close", "201500");
  scenario.live.status({ realtime: "reconnecting", since: AT_1000, backfilling: false });
  await expect(page.getByRole("contentinfo")).toContainText("다시 연결하는 중");
  scenario.live.status({ realtime: "live", since: AT_1000, backfilling: false });
  await expect(page.getByRole("contentinfo")).not.toContainText("다시 연결하는 중");
  scenario.live.bar("005930", bar(NOV9, 202_000));
  await expect(chart).toHaveAttribute("data-last-close", "202000");
});

test("확정 분봉 뒤 새 현재 봉을 받고 기존 봉과 함께 표시한다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930&period=1m");
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => scenario.live.subscriptions().some(value => value.period === "1m")).toBe(true);
  const count = Number(await chart.getAttribute("data-bar-count"));
  scenario.live.bar("005930", bar(AT_1000, 201_000));
  await expect(chart).toHaveAttribute("data-last-close", "201000");
  scenario.live.bar("005930", bar(AT_1000, 201_000), "confirmed");
  scenario.live.bar("005930", bar(AT_1000 + 60, 200_500));
  await expect(chart).toHaveAttribute("data-bar-count", String(count + 1));
  await expect(chart).toHaveAttribute("data-last-bar-t", String(AT_1000 + 60));
  await expect(chart).toHaveAttribute("data-last-close", "200500");
});

test("실시간 중단 상태에서도 HTTP 조회 차트와 주기 전환을 유지한다", async ({ page, scenario }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  scenario.live.status({ realtime: "halted", since: AT_1000, backfilling: false });
  await expect(page.getByRole("contentinfo")).toContainText("실시간 멈춤: 서버를 다시 켜야 합니다");
  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => Number(await chartOf(cell(page)).getAttribute("data-bar-count"))).toBeGreaterThan(0);
  await expect(page.getByRole("contentinfo")).toContainText("실시간 멈춤: 서버를 다시 켜야 합니다");
});

test("둘째 탭에 HTTP 페이지보다 늦게 온 옛 subscribed가 새 봉을 되돌리지 않는다", async ({ page, scenario, context }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const second = await context.newPage();
  const data = scenario.market.page({ symbol: "005930" });
  scenario.reply("/api/bars", { body: { ...data, current: bar(NOV9, 202_000), seq: 20 } });
  let sendOld = () => {};
  await second.routeWebSocket("**/api/ws", socket => {
    socket.send(JSON.stringify({ type: "hello", protocol: 1, serverTime: AT_1000, status: { realtime: "live", since: AT_1000, backfilling: false } } satisfies ServerMessage));
    socket.onMessage(message => {
      const input = JSON.parse(String(message));
      if (input.type === "subscribe") sendOld = () => socket.send(JSON.stringify({ type: "subscribed", sub: input.sub, seq: 10, current: bar(NOV9, 201_000) } satisfies ServerMessage));
    });
  });
  await second.goto("/?symbol=005930");
  const chart = chartOf(cell(second));
  await expect(chart).toHaveAttribute("data-last-close", "202000");
  sendOld();
  await second.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(chart).toHaveAttribute("data-last-close", "202000");
});
