import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ProgramSeriesPage } from "../src/api/generated/ProgramSeriesPage";
import type { TickCvdPage } from "../src/api/generated/TickCvdPage";
import { kstDateOf } from "../src/chart/barJump";
import { MAX_RANGE_DAYS } from "../src/chart/quotes/coverage";
import { formatBarTime, toChartTime } from "../src/chart/time";
import { installChartProbe } from "./chart-probe";
import { cell, chartOf, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";
import { selectMinute } from "./select-option";

function rangeSpanDays(url: URL): number {
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  const fromDay = Date.parse(`${kstDateOf(from)}T00:00:00Z`) / 86_400_000;
  const toDay = Date.parse(`${kstDateOf(to)}T00:00:00Z`) / 86_400_000;
  return toDay - fromDay + 1;
}

test("1분봉에서 계층별 CVD와 프로그램 수급을 추가하고 실시간 0B·0w 프레임으로 재조회 없이 갱신한다", async ({ page, scenario }) => {
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
  await dialog.getByRole("option", { name: "계층별 CVD", exact: true }).click();
  await dialog.getByRole("option", { name: "프로그램 수급", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

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

test("수집 폴더 미설정과 일봉 전환 시 깔끔한 상태 문구를 보인다", async ({ page }) => {
  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "계층별 CVD", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const cvdRow = page.locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  await expect(cvdRow).toHaveCount(1);
  await expect(cvdRow).toContainText("수집 폴더 미설정");

  const periods = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" });
  await periods.getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(cvdRow).toContainText("주식·ETF 분봉 전용");
});

test("60분봉에서 31일 초과 구간을 31일 이하 청크로 분할 조회해 계층별 CVD와 프로그램 수급을 표시한다", async ({ page, scenario }) => {
  const sample = scenario.market.page({ symbol: "005930", period: "60m", venue: "combined" });
  const bars = sample.current ? [...sample.bars, sample.current] : sample.bars;
  const cvdSpans: number[] = [];
  const programSpans: number[] = [];

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/tick-cvd$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const span = rangeSpanDays(url);
      cvdSpans.push(span);
      if (span > MAX_RANGE_DAYS) {
        return { status: 400, body: { error: { code: "bad_request", message: "조회 범위 초과" } } };
      }
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const body: TickCvdPage = {
        symbol: "005930",
        period: "60m",
        state: "ready",
        points: bars
          .filter((b) => b.t >= from && b.t <= to)
          .map((b) => ({
            t: b.t,
            whaleNetMillionWon: 120,
            largeNetMillionWon: 30,
            midNetMillionWon: 10,
            retailNetMillionWon: -15,
          })),
      };
      return { body };
    },
  );

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const span = rangeSpanDays(url);
      programSpans.push(span);
      if (span > MAX_RANGE_DAYS) {
        return { status: 400, body: { error: { code: "bad_request", message: "조회 범위 초과" } } };
      }
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: "60m",
        state: "ready",
        points: bars
          .filter((b) => b.t >= from && b.t <= to)
          .map((b) => ({
            t: b.t,
            netBuyAmountMillionWon: 180,
            netBuyQty: 2000,
            buyAmountMillionWon: 400,
            sellAmountMillionWon: 220,
            programSharePct: 16.5,
            dayTradedMillionWon: 3757.5,
          })),
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=60m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "계층별 CVD", exact: true }).click();
  await dialog.getByRole("option", { name: "프로그램 수급", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const cvdRow = page.locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  const programRow = page.locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });
  await expect(cvdRow).toContainText("초대형 +1.20억");
  await expect(programRow).toContainText("순매수 +1.80억");

  await pollSaved(() => cvdSpans.length >= 2 && programSpans.length >= 2, { message: "60분봉 다중 청크 조회 대기" }).toBe(true);
  expect(cvdSpans.every((span) => span <= MAX_RANGE_DAYS)).toBe(true);
  expect(programSpans.every((span) => span <= MAX_RANGE_DAYS)).toBe(true);
});

test("계층별 CVD 없이 프로그램 수급 비중을 켜면 0B trades를 구독하고 당일 누적 거래대금 기준으로 비중을 갱신한다", async ({ page, scenario }) => {
  const sample = scenario.market.page({ symbol: "005930", period: "1m", venue: "combined" });
  const bars = sample.current ? [...sample.bars, sample.current] : sample.bars;
  const lastBar = bars[bars.length - 1]!;

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    () => {
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: "1m",
        state: "ready",
        points: bars.map((b) => ({
          t: b.t,
          netBuyAmountMillionWon: 200,
          netBuyQty: 2500,
          buyAmountMillionWon: 500,
          sellAmountMillionWon: 300,
          programSharePct: 20,
          dayTradedMillionWon: 4000,
        })),
      };
      return { body };
    },
  );

  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "프로그램 수급", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const programRow = page.locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });
  await expect(programRow).toContainText("순매수 +2.00억");

  await programRow.locator("[data-indicator-edit]").first().click();
  const popover = page.getByRole("dialog", { name: "프로그램 수급 설정" });
  await popover.getByRole("switch", { name: "프로그램 비중(%) 표시" }).click();
  await popover.getByRole("button", { name: "설정 닫기" }).click();
  await page.mouse.move(0, 0);

  await expect(programRow).toContainText("비중 20.0%");

  const tradeSub = await pollSaved(
    () =>
      scenario.live.messages.find(
        (m) => m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "trades",
      ),
    { message: "프로그램 비중용 0B trades 구독 대기" },
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
    { message: "0w program 구독 대기" },
  ).toBeDefined().then(() =>
    scenario.live.messages.find(
      (m): m is Extract<typeof m, { type: "subscribe_feed" }> =>
        m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "program",
    )!.sub,
  );

  scenario.live.emit({
    type: "feed_trades",
    sub: tradeSub,
    seq: 1,
    trades: [{ t: lastBar.t + 10, price: 100_000, qty: 10_000, venue: "krx", strength: 105 }],
  });
  scenario.live.emit({
    type: "feed_program",
    sub: programSub,
    row: {
      t: lastBar.t + 15,
      price: 100_000,
      sellQty: 4500,
      sellAmount: 450,
      buyQty: 8000,
      buyAmount: 800,
      netQty: 3500,
      netQtyChange: 1000,
      netAmount: 350,
      netAmountChange: 150,
    },
  });

  await expect(programRow).toContainText("순매수 +3.50억");
  await expect(programRow).toContainText("비중 25.0%");
});

test("계층별 CVD 마지막 활성 계층은 끌 수 없고 아래 프로그램 수급 범례가 가격 패널로 밀리지 않는다", async ({ page }) => {
  await page.goto("/?symbol=005930&period=1m");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: /^지표/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: "계층별 CVD", exact: true }).click();
  await dialog.getByRole("option", { name: "프로그램 수급", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);

  const cvdRow = page.locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  const programRow = page.locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });
  await expect(cvdRow).toHaveCount(1);
  await expect(programRow).toHaveCount(1);

  await cvdRow.locator("[data-indicator-edit]").first().click();
  const popover = page.getByRole("dialog", { name: "계층별 CVD 설정" });
  const whaleSwitch = popover.getByRole("switch", { name: "초대형(1억+)" });
  const retailSwitch = popover.getByRole("switch", { name: "소형(5백만 미만)" });

  await whaleSwitch.click();
  await expect(whaleSwitch).toHaveAttribute("aria-checked", "false");
  await expect(retailSwitch).toHaveAttribute("aria-checked", "true");
  await expect(retailSwitch).toBeDisabled();
  await popover.getByRole("button", { name: "설정 닫기" }).click();

  const cvdBox = await cvdRow.boundingBox();
  const progBox = await programRow.boundingBox();
  expect(cvdBox).not.toBeNull();
  expect(progBox).not.toBeNull();
  expect(progBox!.y).toBeGreaterThan(cvdBox!.y + 20);
});

test("과거 보기 진입 시 실시간 0B·0w 구독을 해제하고 오늘 체결이 과거 차트로 새지 않는다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date("2026-11-09T10:00:00+09:00"));
  await page.addInitScript(installChartProbe);

  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const dailyWindow: LayoutWindow = {
    id: "cell-0",
    link: null,
    kind: "chart",
    symbol: "005930",
    venue: "combined",
    period: "D",
    chartSettings: { v: 2, style: "candle", scale: "normal", indicators: [], compare: [], panels: [], visibleBars: 50 },
  };
  const minuteWindow: LayoutWindow = {
    id: "cell-1",
    link: null,
    kind: "chart",
    symbol: "005930",
    venue: "combined",
    period: "5m",
    chartSettings: {
      v: 2,
      style: "candle",
      scale: "normal",
      indicators: [
        { id: "cvd-1", spec: { kind: "tickCvd", showWhale: true, showLarge: false, showMid: false, showRetail: true }, panel: "p-cvd", visible: true, style: { colors: ["ind-1", "ind-2"], width: 1 } },
        { id: "prog-1", spec: { kind: "programFlow", showShare: false }, panel: "p-prog", visible: true, style: { colors: ["ind-3"], width: 1 } },
      ],
      compare: [],
      panels: [
        { id: "p-cvd", stretch: 0.25 },
        { id: "p-prog", stretch: 0.25 },
      ],
      visibleBars: 50,
    },
  };
  scenario.documents.saveLayout({
    ...layout,
    windows: [dailyWindow, minuteWindow],
    placement: {
      v: 1,
      dock: {
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.5,
          first: { kind: "group", id: "g1", tabs: ["cell-0"], active: "cell-0" },
          second: { kind: "group", id: "g2", tabs: ["cell-1"], active: "cell-1" },
        },
        floats: [],
      },
      canvas: null,
    },
    revision: layout.revision + 1,
  });

  const dailyPage = scenario.market.page({ symbol: "005930", period: "D" });
  const dailyBars = dailyPage.current ? [...dailyPage.bars, dailyPage.current] : dailyPage.bars;
  const targetDate = formatBarTime(dailyBars.at(-1 - 8)!.t, "D");
  const jumpBars = scenario.market.jumpPage({ symbol: "005930", period: "5m", date: targetDate }).bars;
  const jumpLastBar = jumpBars[jumpBars.length - 1]!;
  const liveSample = scenario.market.page({ symbol: "005930", period: "5m", venue: "combined" });
  const liveBars = liveSample.current ? [...liveSample.bars, liveSample.current] : liveSample.bars;
  const liveLastBar = liveBars[liveBars.length - 1]!;

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/tick-cvd$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const isJump = from <= jumpLastBar.t && jumpLastBar.t <= to;
      const body: TickCvdPage = {
        symbol: "005930",
        period: "5m",
        state: "ready",
        points: (isJump ? jumpBars : liveBars).map((b) => ({
          t: b.t,
          whaleNetMillionWon: isJump ? 70 : 150,
          largeNetMillionWon: 0,
          midNetMillionWon: 0,
          retailNetMillionWon: isJump ? -5 : -20,
        })),
      };
      return { body };
    },
  );

  scenario.on(
    (url, request) => request.method() === "GET" && /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
    (request) => {
      const url = new URL(request.url());
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const isJump = from <= jumpLastBar.t && jumpLastBar.t <= to;
      const body: ProgramSeriesPage = {
        symbol: "005930",
        period: "5m",
        state: "ready",
        points: (isJump ? jumpBars : liveBars).map((b) => ({
          t: b.t,
          netBuyAmountMillionWon: isJump ? 45 : 220,
          netBuyQty: 500,
          buyAmountMillionWon: 100,
          sellAmountMillionWon: 55,
          programSharePct: 12,
          dayTradedMillionWon: 1291,
        })),
      };
      return { body };
    },
  );

  await page.goto("/");
  await expect(cell(page, 1)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page, 2)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => page.evaluate(() => window.chartProbes?.length ?? 0)).toBeGreaterThanOrEqual(2);

  const tradeSub = await pollSaved(
    () => scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "trades"),
    { message: "초기 0B 구독 대기" },
  ).toBeDefined().then(() =>
    scenario.live.messages.find(
      (m): m is Extract<typeof m, { type: "subscribe_feed" }> =>
        m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "trades",
    )!.sub,
  );
  const programSub = await pollSaved(
    () => scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "program"),
    { message: "초기 0w 구독 대기" },
  ).toBeDefined().then(() =>
    scenario.live.messages.find(
      (m): m is Extract<typeof m, { type: "subscribe_feed" }> =>
        m.type === "subscribe_feed" && m.symbol === "005930" && m.kind === "program",
    )!.sub,
  );

  await page.evaluate(({ back }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const count = Number(probe?.chart.chartElement().closest("section")?.querySelector("[data-bar-count]")?.getAttribute("data-bar-count"));
    const index = count - 1 - back;
    probe?.chart.timeScale().setVisibleLogicalRange({ from: index - 49, to: index });
  }, { back: 8 });

  const clickedBar = dailyBars.at(-1 - 20)!;
  const clickPt = await page.evaluate(({ time }) => {
    const probe = window.chartProbes.find((p) => p.chart.chartElement().closest("section")?.getAttribute("aria-label")?.startsWith("칸 1: "));
    const x = probe?.chart.timeScale().timeToCoordinate(time);
    const box = probe?.chart.chartElement().getBoundingClientRect();
    if (!probe || x === null || x === undefined || !box) throw new Error("가리킬 봉이 화면 밖입니다");
    return { x: box.x + x, y: box.y + box.height * 0.4 };
  }, { time: toChartTime(clickedBar.t) });

  await page.mouse.click(clickPt.x, clickPt.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await menu.getByRole("menuitem", { name: `바로가기 · ${targetDate}` }).click();

  await expect(chartOf(cell(page, 2))).toHaveAttribute("data-last-bar-t", String(jumpLastBar.t));
  await pollSaved(
    () =>
      scenario.live.messages.some((m) => m.type === "unsubscribe" && m.sub === tradeSub)
      && scenario.live.messages.some((m) => m.type === "unsubscribe" && m.sub === programSub),
    { message: "과거 보기 진입 후 0B·0w 구독 해제 대기" },
  ).toBe(true);

  const cvdRow = cell(page, 2).locator("[data-indicator-row]").filter({ hasText: "계층별 CVD" });
  const programRow = cell(page, 2).locator("[data-indicator-row]").filter({ hasText: "프로그램 수급" });
  await expect(cvdRow).toContainText("초대형 +70백만");
  await expect(programRow).toContainText("순매수 +45백만");

  scenario.live.emit({
    type: "feed_trades",
    sub: tradeSub,
    seq: 99,
    trades: [{ t: liveLastBar.t + 10, price: 100_000, qty: 9_990, venue: "krx", strength: 200 }],
  });
  scenario.live.emit({
    type: "feed_program",
    sub: programSub,
    row: {
      t: liveLastBar.t + 10,
      price: 100_000,
      sellQty: 0,
      sellAmount: 0,
      buyQty: 9990,
      buyAmount: 999,
      netQty: 9990,
      netQtyChange: 9990,
      netAmount: 999,
      netAmountChange: 999,
    },
  });

  await expect(cvdRow).toContainText("초대형 +70백만");
  await expect(programRow).toContainText("순매수 +45백만");
});
