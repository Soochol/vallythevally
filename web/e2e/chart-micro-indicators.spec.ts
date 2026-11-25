import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import type { TickCvdPage } from "../src/api/generated/TickCvdPage";
import { cell, expect, pollSaved, test } from "./harness";
import { useCenterIndicatorWindow } from "./indicator-window";
import { selectMinute } from "./select-option";

test("1분봉에서 계층별 CVD와 프로그램 수급을 추가하고 실시간 0B·0w 프레임으로 재조회 없이 갱신한다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  const sample = scenario.market.page({ symbol: "005930", period: "1m", venue: "combined" });
  const bars = sample.current ? [...sample.bars, sample.current] : sample.bars;
  const lastBar = bars[bars.length - 1]!;
  const cvdRequests: string[] = [];
  const programRequests: string[] = [];

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/tick-cvd$/.test(url.pathname),
    (request) => {
      cvdRequests.push(request.url());
      const body: TickCvdPage = {
        symbol: "005930",
        period: "1m",
        state: "ready",
        points: bars.map((b) => ({
          t: b.t,
          whaleNetMillionWon: 150,
          largeNetMillionWon: 40,
          midNetMillionWon: 10,
          retailNetMillionWon: -30,
        })),
      };
      return { body };
    },
  );

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request) => {
      programRequests.push(request.url());
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: "1m",
        state: "ready",
        points: bars.map((b) => ({
          t: b.t,
          netBuyAmountMillionWon: 240,
          netBuyQty: 3000,
          buyAmountMillionWon: 500,
          sellAmountMillionWon: 260,
          programSharePct: 18.5,
        })),
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=D");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
  await selectMinute(periods.getByRole("button", { name: "분봉", exact: true }), "1m");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 1분");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "계층별 CVD 추가 후보", exact: true }).click();
  await dialog.getByRole("option", { name: "프로그램 수급 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();

  const cvdRow = page.locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  const programRow = page.locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });

  await expect(cvdRow).toHaveCount(1);
  await expect(cvdRow).toContainText("초대형 +1.50억");
  await expect(cvdRow).toContainText("소형 −30백만");
  await expect(cvdRow).not.toContainText("대형 +40백만");
  await expect(cvdRow).not.toContainText("중형");

  await expect(programRow).toHaveCount(1);
  await expect(programRow).toContainText("순매수 +2.40억");
  await expect(programRow).not.toContainText("비중");

  const tradeSub = await pollSaved(
    () =>
      scenario.live.messages.find(
        (m) => m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "trades",
      ),
    { message: "0B trades 실시간 구독 대기" },
  ).toBeDefined().then(() =>
    scenario.live.messages.find(
      (m): m is Extract<typeof m, { type: "subscribe_feed" }> =>
        m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "trades",
    )!.sub,
  );

  const programSub = await pollSaved(
    () =>
      scenario.live.messages.find(
        (m) => m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "program",
      ),
    { message: "0w program 실시간 구독 대기" },
  ).toBeDefined().then(() =>
    scenario.live.messages.find(
      (m): m is Extract<typeof m, { type: "subscribe_feed" }> =>
        m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "program",
    )!.sub,
  );

  const cvdCountBefore = cvdRequests.length;
  const programCountBefore = programRequests.length;

  scenario.live.emit({
    type: "feed_trades",
    sub: tradeSub,
    seq: 1,
    trades: [{ t: lastBar.t + 15, price: 100_000, qty: 1_400, venue: "krx", strength: 112.5 }],
  });
  scenario.live.emit({
    type: "feed_program",
    sub: programSub,
    row: {
      t: lastBar.t + 20,
      price: 100_000,
      sellQty: 2600,
      sellAmount: 290,
      buyQty: 6500,
      buyAmount: 650,
      netQty: 4500,
      netQtyChange: 1500,
      netAmount: 360,
      netAmountChange: 120,
    },
  });

  await expect(cvdRow).toContainText("초대형 +2.90억");
  await expect(cvdRow).toContainText("소형 −30백만");
  await expect(programRow).toContainText("순매수 +3.60억");

  expect(cvdRequests.length).toBe(cvdCountBefore);
  expect(programRequests.length).toBe(programCountBefore);
});

test("수집 폴더 미설정과 일봉 전환 시 깔끔한 상태 문구를 보인다", async ({ page, scenario }) => {
  useCenterIndicatorWindow(scenario);
  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "지표 추가", exact: true }).click();
  await dialog.getByRole("option", { name: "계층별 CVD 추가 후보", exact: true }).click();
  await dialog.getByRole("button", { name: "입력창 닫기", exact: true }).click();

  const cvdRow = page.locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  await expect(cvdRow).toHaveCount(1);
  await expect(cvdRow).toContainText("수집 폴더 미설정");

  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
  await periods.getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(cvdRow).toContainText("주식·ETF 분봉 전용");
});
