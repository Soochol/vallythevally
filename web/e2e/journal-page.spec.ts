import { expect, test, type Scenario } from "./harness";

interface HistoryDayFixture {
  readonly day: string;
  readonly executions: readonly {
    readonly orderNo: string;
    readonly code: string;
    readonly name: string;
    readonly side: "buy" | "sell";
    readonly quantity: number;
    readonly price: number;
    readonly time: string;
    readonly venue: "krx" | "nxt" | "combined";
  }[];
}

const DEFAULT_TODAY_DAYS: readonly HistoryDayFixture[] = [
  {
    day: "2026-11-27",
    executions: [
      { orderNo: "B1", code: "005930", name: "삼성전자", side: "buy", quantity: 20, price: 70_000, time: "09:05:00", venue: "krx" },
      { orderNo: "S1", code: "005930", name: "삼성전자", side: "sell", quantity: 20, price: 72_000, time: "09:22:00", venue: "krx" },
      { orderNo: "B2", code: "000660", name: "SK하이닉스", side: "buy", quantity: 10, price: 200_000, time: "11:45:00", venue: "krx" },
      { orderNo: "B3", code: "000660", name: "SK하이닉스", side: "buy", quantity: 10, price: 198_000, time: "12:02:00", venue: "krx" },
      { orderNo: "S2", code: "000660", name: "SK하이닉스", side: "sell", quantity: 20, price: 195_000, time: "12:35:00", venue: "krx" },
    ],
  },
];

const MULTI_PERIOD_DAYS: readonly HistoryDayFixture[] = [
  {
    day: "2025-11-12",
    executions: [
      { orderNo: "Y0B1", code: "035420", name: "NAVER", side: "buy", quantity: 5, price: 180_000, time: "09:10:00", venue: "krx" },
      { orderNo: "Y0S1", code: "035420", name: "NAVER", side: "sell", quantity: 5, price: 190_000, time: "10:15:00", venue: "krx" },
    ],
  },
  {
    day: "2026-03-10",
    executions: [
      { orderNo: "M3B1", code: "005380", name: "현대차", side: "buy", quantity: 10, price: 240_000, time: "09:08:00", venue: "krx" },
      { orderNo: "M3S1", code: "005380", name: "현대차", side: "sell", quantity: 10, price: 252_000, time: "09:42:00", venue: "krx" },
    ],
  },
  {
    day: "2026-10-15",
    executions: [
      { orderNo: "M10B1", code: "042700", name: "한미반도체", side: "buy", quantity: 10, price: 110_000, time: "09:12:00", venue: "krx" },
      { orderNo: "M10S1", code: "042700", name: "한미반도체", side: "sell", quantity: 10, price: 116_000, time: "10:05:00", venue: "krx" },
    ],
  },
  {
    day: "2026-11-05",
    executions: [
      { orderNo: "N5B1", code: "064350", name: "현대로템", side: "buy", quantity: 20, price: 60_000, time: "09:06:00", venue: "krx" },
      { orderNo: "N5S1", code: "064350", name: "현대로템", side: "sell", quantity: 20, price: 62_500, time: "09:28:00", venue: "krx" },
    ],
  },
  {
    day: "2026-11-24",
    executions: [
      { orderNo: "W1B1", code: "012450", name: "한화에어로스페이스", side: "buy", quantity: 4, price: 350_000, time: "09:15:00", venue: "krx" },
      { orderNo: "W1S1", code: "012450", name: "한화에어로스페이스", side: "sell", quantity: 4, price: 360_000, time: "10:20:00", venue: "krx" },
    ],
  },
  ...DEFAULT_TODAY_DAYS,
];

function seedJournalHistory(
  scenario: Scenario,
  days: readonly HistoryDayFixture[] = DEFAULT_TODAY_DAYS,
  requestedRanges: Array<{ from: string | null; to: string | null }> = [],
) {
  scenario.on(
    (url) => url.pathname === "/api/trading/executions/history",
    (request) => {
      const url = new URL(request.url());
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      requestedRanges.push({ from, to });
      const filtered = days.filter((entry) => {
        if (from !== null && entry.day < from) return false;
        if (to !== null && entry.day > to) return false;
        return true;
      });
      return {
        status: 200,
        body: {
          accountRef: "acc-1",
          today: "2026-11-27",
          from: from ?? days[0]?.day ?? "2026-11-27",
          to: to ?? "2026-11-27",
          days: filtered,
          pendingDays: 0,
        },
      };
    },
  );
  scenario.on(
    (url) => url.pathname === "/api/trading/executions/forensics",
    (request) => {
      const url = new URL(request.url());
      return {
        status: 200,
        body: {
          date: url.searchParams.get("date") ?? "20261127",
          account: "acc-1",
          items: [],
        },
      };
    },
  );
}

test("/journal에서 타점 복기 스튜디오와 어디서 벌고 잃었나가 즉시 필터 연동된다", async ({ page, scenario }) => {
  seedJournalHistory(scenario);
  await page.goto("/journal");

  await expect(page.getByTestId("journal-page")).toBeVisible();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 2건");
  await expect(page.getByTestId("journal-candle-chart")).toBeVisible();
  await expect(page.getByTestId("journal-where-section")).toBeVisible();

  await page.getByTestId("journal-pair-open_open").click();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-token-pair")).toBeVisible();
  await expect(page.getByTestId("journal-where-jump-top")).toContainText("1건");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 2건");

  await page.getByTestId("journal-memo-input").fill("시초 거래대금 돌파 확인");
  await expect(page.getByTestId("journal-memo-input")).toHaveValue("시초 거래대금 돌파 확인");

  await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일봉", exact: true }).click();
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-tf", "D");
});

test("/journal과 /journal/analytics 2페이지가 분리되어 오가며 날짜·행 클릭 시 복기로 점프한다", async ({ page, scenario }) => {
  seedJournalHistory(scenario);
  await page.goto("/journal");

  await page.getByTestId("journal-go-analytics").click();
  await expect(page).toHaveURL(/\/journal\/analytics$/);
  await expect(page.getByTestId("journal-analytics-view")).toBeVisible();
  await expect(page.getByTestId("journal-where-section")).toHaveCount(0);

  const afterCostText = await page.getByTestId("analytics-net-pnl").innerText();
  await page.getByTestId("analytics-cost-switch").click();
  await expect(page.getByTestId("analytics-net-pnl")).not.toHaveText(afterCostText);
  await page.getByTestId("analytics-cost-switch").click();

  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "달력", exact: true }).click();
  await page.getByTestId("analytics-cal-day-2026-11-27").click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByTestId("journal-period-label")).toContainText("2026.11.27");

  await page.getByTestId("journal-go-analytics").click();
  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "월", exact: true }).click();
  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "표", exact: true }).click();
  await page.getByRole("group", { name: "표 묶음 단위" }).getByRole("button", { name: "종목별", exact: true }).click();
  await page.getByTestId("analytics-table-row-005930").click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-detail-name")).toHaveText("삼성전자");
});

test("/journal과 /journal/analytics에서 과거 기간(주·월·이전월·년·전체) 체결이 모두 조회된다", async ({ page, scenario }) => {
  const requests: Array<{ from: string | null; to: string | null }> = [];
  seedJournalHistory(scenario, MULTI_PERIOD_DAYS, requests);
  await page.goto("/journal");

  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 4건");
  await expect(page.getByTestId("journal-trade-row-064350")).toBeVisible();
  await expect(page.getByTestId("journal-trade-row-012450")).toBeVisible();

  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "주", exact: true }).click();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 3건");
  await expect(page.getByTestId("journal-trade-row-012450")).toBeVisible();

  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "월", exact: true }).click();
  await page.getByRole("button", { name: "이전 기간", exact: true }).click();
  await expect(page.getByTestId("journal-period-label")).toContainText("2026년 10월");
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-trade-row-042700")).toBeVisible();
  expect(requests.some((r) => r.from === "2026-09-17" && r.to === "2026-10-31")).toBe(true);

  await page.getByTestId("journal-go-analytics").click();
  await expect(page).toHaveURL(/\/journal\/analytics$/);
  await expect(page.getByTestId("analytics-period-label")).toContainText("2026년 10월");

  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "달력", exact: true }).click();
  await expect(page.getByTestId("analytics-cal-day-2026-10-15")).toContainText("1건");

  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "년", exact: true }).click();
  await expect(page.getByTestId("analytics-period-label")).toContainText("2026년");
  await page.getByRole("group", { name: "기간별 보기" }).getByRole("button", { name: "표", exact: true }).click();
  await expect(page.getByTestId("analytics-table-row-2026-03")).toBeVisible();
  await expect(page.getByTestId("analytics-table-row-2026-10")).toBeVisible();
  await expect(page.getByTestId("analytics-table-row-2026-11")).toBeVisible();

  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByTestId("analytics-table-row-2025-11")).toBeVisible();
  expect(requests.some((r) => r.from === null && r.to === null)).toBe(true);

  await page.getByTestId("analytics-table-row-2025-11").click();
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByTestId("journal-period-label")).toContainText("2025년 11월");
  await expect(page.getByTestId("journal-trade-row-035420")).toBeVisible();
});

test("장기 과거 기간이 pendingDays로 나눠 동기화되면 자동으로 이어 받아 과거 거래를 채운다", async ({ page, scenario }) => {
  let yearCalls = 0;
  scenario.on(
    (url) => url.pathname === "/api/trading/executions/history",
    (request) => {
      const url = new URL(request.url());
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from === "2025-12-18" && to === "2026-12-31") {
        yearCalls += 1;
        if (yearCalls === 1) {
          return {
            status: 200,
            body: {
              accountRef: "acc-1",
              today: "2026-11-27",
              from,
              to,
              days: DEFAULT_TODAY_DAYS,
              pendingDays: 12,
            },
          };
        }
        return {
          status: 200,
          body: {
            accountRef: "acc-1",
            today: "2026-11-27",
            from,
            to,
            days: MULTI_PERIOD_DAYS.filter((d) => d.day >= "2026-01-01"),
            pendingDays: 0,
          },
        };
      }
      return {
        status: 200,
        body: {
          accountRef: "acc-1",
          today: "2026-11-27",
          from: from ?? "2026-11-01",
          to: to ?? "2026-11-30",
          days: DEFAULT_TODAY_DAYS,
          pendingDays: 0,
        },
      };
    },
  );
  await page.goto("/journal");
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 2건");

  await page.getByRole("group", { name: "기간 단위" }).getByRole("button", { name: "년", exact: true }).click();
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 6건");
  await expect(page.getByTestId("journal-trade-row-005380")).toBeVisible();
  expect(yearCalls).toBe(2);
});

test("매매복기 차트가 1·3·5·10분·일봉을 모두 지원하고 왼쪽 스크롤 시 과거 봉을 제한 없이 이어 받는다", async ({ page, scenario }) => {
  seedJournalHistory(scenario);
  const periodsRequested: string[] = [];
  const beforeRequested: string[] = [];

  const baseT = Math.floor(Date.parse("2026-11-27T09:00:00+09:00") / 1000);
  const makeMinuteBars = (start: number, stepSec: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      t: start + i * stepSec,
      o: 70_000 + (i % 5) * 100,
      h: 72_200,
      l: 69_800,
      c: 71_000 + (i % 4) * 100,
      v: 1_200 + i * 10,
      s: "query" as const,
    }));

  scenario.on(
    (url) => url.pathname === "/api/bars",
    (request) => {
      const url = new URL(request.url());
      const symbol = url.searchParams.get("symbol") ?? "005930";
      const venue = url.searchParams.get("venue") ?? "krx";
      const period = url.searchParams.get("period") ?? "1m";
      const before = url.searchParams.get("before");
      periodsRequested.push(period);
      const stepSec =
        period === "D" ? 86_400 : period === "10m" ? 600 : period === "5m" ? 300 : period === "3m" ? 180 : 60;
      if (before !== null) {
        beforeRequested.push(before);
        const beforeNum = Number(before);
        return {
          status: 200,
          body: {
            symbol,
            venue,
            period,
            bars: makeMinuteBars(beforeNum - 60 * stepSec, stepSec, 60),
            current: null,
            nextBefore: null,
            seq: 1,
          },
        };
      }
      const firstT = baseT - 20 * stepSec;
      return {
        status: 200,
        body: {
          symbol,
          venue,
          period,
          bars: makeMinuteBars(firstT, stepSec, 60),
          current: null,
          nextBefore: firstT,
          seq: 1,
        },
      };
    },
  );

  await page.goto("/journal");
  const chart = page.getByTestId("journal-candle-chart");
  await expect(chart).toBeVisible();

  const tfButtons = page.getByRole("group", { name: "봉 주기" });
  for (const [label, tf, period] of [
    ["1분", "1", "1m"],
    ["3분", "3", "3m"],
    ["5분", "5", "5m"],
    ["10분", "10", "10m"],
    ["일봉", "D", "D"],
  ] as const) {
    await tfButtons.getByRole("button", { name: label, exact: true }).click();
    await expect(chart).toHaveAttribute("data-tf", tf);
    await expect(chart).toHaveAttribute("data-period", period);
  }
  for (const period of ["1m", "3m", "5m", "10m", "D"]) {
    expect(periodsRequested).toContain(period);
  }

  await tfButtons.getByRole("button", { name: "1분", exact: true }).click();
  await expect(chart).toHaveAttribute("data-bar-count", "120");
  expect(beforeRequested.length).toBeGreaterThan(0);

  const initialFrom = Number(await chart.getAttribute("data-visible-from"));
  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width * 0.5;
  const cy = box!.y + box!.height * 0.5;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => Number(await chart.getAttribute("data-visible-from"))).toBeLessThan(initialFrom);
});

test("과거일 분봉 점프가 비어 있으면 당일 봉이나 합성 봉을 그리지 않고 안내를 띄우며, 월 경계 스윙 거래도 표시한다", async ({ page, scenario }) => {
  const crossMonthDays: readonly HistoryDayFixture[] = [
    {
      day: "2026-10-30",
      executions: [
        { orderNo: "SW1", code: "035420", name: "NAVER", side: "buy", quantity: 10, price: 180_000, time: "14:30:00", venue: "krx" },
      ],
    },
    {
      day: "2026-11-02",
      executions: [
        { orderNo: "SW2", code: "035420", name: "NAVER", side: "sell", quantity: 10, price: 192_000, time: "09:20:00", venue: "krx" },
      ],
    },
  ];
  seedJournalHistory(scenario, crossMonthDays);

  scenario.on(
    (url) => url.pathname === "/api/bars/jump",
    (request) => {
      const url = new URL(request.url());
      return {
        status: 200,
        body: {
          symbol: url.searchParams.get("symbol") ?? "035420",
          venue: url.searchParams.get("venue") ?? "krx",
          period: url.searchParams.get("period") ?? "1m",
          date: url.searchParams.get("date") ?? "2026-11-02",
          bars: [],
          nextBefore: null,
          unadjustedDays: [],
        },
      };
    },
  );

  await page.goto("/journal");
  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 1건");
  await expect(page.getByTestId("journal-trade-row-035420")).toBeVisible();

  await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "1분", exact: true }).click();
  await expect(page.getByTestId("journal-chart-notice")).toBeVisible();
  await expect(page.getByTestId("journal-chart-notice")).toContainText("2026-11-02 분봉 데이터가 없습니다");
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-bar-count", "0");
});

test("같은 날 같은 종목 다회 거래를 좌측 슬림 카드로 묶고 우측 회차 탭과 체결 행 스포트라이트로 복기한다", async ({ page, scenario }) => {
  const groupedDays: readonly HistoryDayFixture[] = [
    {
      day: "2026-11-26",
      executions: [
        { orderNo: "L0B1", code: "328130", name: "루닛", side: "buy", quantity: 10, price: 51_000, time: "09:10:00", venue: "krx" },
        { orderNo: "L0S1", code: "328130", name: "루닛", side: "sell", quantity: 10, price: 52_500, time: "09:30:00", venue: "krx" },
      ],
    },
    {
      day: "2026-11-27",
      executions: [
        { orderNo: "L1B1", code: "328130", name: "루닛", side: "buy", quantity: 10, price: 54_000, time: "09:06:05", venue: "krx" },
        { orderNo: "L1B2", code: "328130", name: "루닛", side: "buy", quantity: 15, price: 54_200, time: "09:06:22", venue: "krx" },
        { orderNo: "L1B3", code: "328130", name: "루닛", side: "buy", quantity: 15, price: 54_400, time: "09:06:48", venue: "krx" },
        { orderNo: "L1S1", code: "328130", name: "루닛", side: "sell", quantity: 20, price: 56_000, time: "09:22:10", venue: "krx" },
        { orderNo: "L1S2", code: "328130", name: "루닛", side: "sell", quantity: 20, price: 56_200, time: "09:22:42", venue: "krx" },
        { orderNo: "L2B1", code: "328130", name: "루닛", side: "buy", quantity: 20, price: 55_600, time: "13:12:00", venue: "krx" },
        { orderNo: "L2S1", code: "328130", name: "루닛", side: "sell", quantity: 20, price: 54_800, time: "13:40:00", venue: "krx" },
        { orderNo: "S1B1", code: "005930", name: "삼성전자", side: "buy", quantity: 10, price: 70_000, time: "10:05:00", venue: "krx" },
        { orderNo: "S1S1", code: "005930", name: "삼성전자", side: "sell", quantity: 10, price: 71_500, time: "10:25:00", venue: "krx" },
      ],
    },
  ];
  seedJournalHistory(scenario, groupedDays);
  await page.goto("/journal");

  await expect(page.getByTestId("journal-list-count")).toHaveText("거래 4건");
  const lunitRows = page.getByTestId("journal-trade-row-328130");
  await expect(lunitRows).toHaveCount(2);

  const lunitTodayRow = page.locator('[data-group-key="2026-11-27|328130"]');
  await expect(lunitTodayRow).toHaveAttribute("data-group-count", "2");
  await expect(lunitTodayRow).toContainText("2건");
  await expect(lunitTodayRow).toHaveAttribute("aria-selected", "true");

  await expect(page.getByTestId("journal-rt-tabs")).toBeVisible();
  await expect(page.getByTestId("journal-rt-tab-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-trade-count", "2");
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-marker-mode", "minimal");
  await expect(page.getByTestId("journal-group-memos")).toBeVisible();

  await page.getByTestId("journal-rt-tab-1").click();
  await expect(page.getByTestId("journal-rt-tab-1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("journal-candle-chart")).toHaveAttribute("data-trade-count", "1");
  await page.getByTestId("journal-memo-input").fill("09:06 3분할 돌파 진입");
  await expect(page.getByTestId("journal-memo-input")).toHaveValue("09:06 3분할 돌파 진입");

  const firstFillRow = page.locator(".jrn-fills tbody tr").first();
  await firstFillRow.hover();
  await expect(firstFillRow).toHaveAttribute("data-fill-highlighted", "true");

  await page.getByTestId("journal-rt-tab-all").click();
  await expect(page.getByTestId("journal-group-memos")).toContainText("09:06 3분할 돌파 진입");

  await page.getByRole("group", { name: "정렬" }).getByRole("button", { name: "손익", exact: true }).click();
  await expect(page.locator('[data-group-key="2026-11-27|328130"]')).toHaveAttribute("data-group-count", "2");
  await page.getByRole("group", { name: "정렬" }).getByRole("button", { name: "수익률", exact: true }).click();
  await expect(page.locator('[data-group-key="2026-11-27|328130"]')).toHaveAttribute("data-group-count", "2");
});
