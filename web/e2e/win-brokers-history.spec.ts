import type { Page } from "@playwright/test";
import type { BarsPage } from "../src/api/generated/BarsPage";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const TODAY = "20261109";
const PAST = "20261106";
test.use({ clockStart: "20261109093230" });

const at = (clock: string, day = "2026-11-09") => Date.parse(`${day}T${clock}+09:00`) / 1000;
const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });
const kiwoom = (t: number, qty: number): FeedBrokers => ({ t, buys: [entry("151", "키움", qty)], sells: [entry("141", "삼성", 90)] });
const day = (patch: Partial<BrokerDay>): BrokerDay => ({ symbol: "005930", date: TODAY, source: "none", snapshots: [], gaps: [], live: true, cursor: "", reset: true, ...patch });

const FLOW = day({ source: "flow", snapshots: [kiwoom(at("08:10:00"), 10), kiwoom(at("09:30:00"), 100)], cursor: "f:1:2" });

const window_ = (page: Page) => page.getByTestId("brokers-window");
const card = (page: Page, name: string) => window_(page).getByTestId("broker-card").and(page.locator(`[data-broker="${name}"]`));
const brokerFeeds = (scenario: Scenario) => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "brokers");

function collected(scenario: Scenario, today: (after: string | null) => BrokerDay, past?: BrokerDay) {
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const query = new URL(request.url()).searchParams;
    return { body: query.get("date") === TODAY ? today(query.get("after")) : (past ?? day({ date: query.get("date")! })) };
  });
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers/days", () => ({ body: { symbol: "005930", days: past === undefined ? [] : [PAST] } }));
}

function minuteBars(scenario: Scenario) {
  scenario.on((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "1m", () => {
    const bars = [["09:00:00", 71_000], ["09:30:00", 71_300], ["09:31:00", 71_400]].map(([clock, close]) => ({ t: at(clock as string), o: close as number, h: close as number, l: close as number, c: close as number, v: 10 }));
    const body: BarsPage = { symbol: "005930", venue: "combined", period: "1m", bars, current: null, nextBefore: null, seq: null };
    return { body };
  });
}

async function openBrokers(page: Page, scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^거래원 입체분석/ }).click();
  await expect(windowTabs(page).getByRole("tab", { name: /^거래원 입체분석/ })).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("오늘 흐름이 있으면 실시간 구독 없이 09:00부터 보이고 새 행을 이어 받는다", async ({ page, scenario }) => {
  collected(scenario, (after) => {
    if (after === "f:1:2") return day({ source: "flow", snapshots: [kiwoom(at("09:32:00"), 700)], cursor: "f:1:3", reset: false });
    if (after === "f:1:3") return day({ source: "flow", cursor: "f:1:3", reset: false });
    return FLOW;
  });
  await openBrokers(page, scenario);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+700");
  expect(brokerFeeds(scenario)).toEqual([]);
  const bars = (await card(page, "키움").getByTestId("broker-bars").boundingBox())!;
  await page.mouse.move(bars.x + 1, bars.y + bars.height / 2);
  await expect(window_(page).getByTestId("brokers-time")).toContainText("09:00");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+10");
});

test("수집 자료가 없으면 실시간을 구독한다", async ({ page, scenario }) => {
  collected(scenario, () => day({}));
  await openBrokers(page, scenario);
  await expect.poll(() => brokerFeeds(scenario).length).toBe(1);
  const request = brokerFeeds(scenario)[0]!;
  if (request.type !== "subscribe_feed") throw new Error("거래원 구독이 없습니다");
  scenario.live.emit({ type: "feed_brokers", sub: request.sub, brokers: kiwoom(at("09:32:00"), 300) });
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+300");
});

test("날짜 이동으로 과거일을 보고 다시 열면 오늘이다", async ({ page, scenario }) => {
  const past = day({ date: PAST, source: "store", live: false, cursor: "s:1:2", snapshots: [kiwoom(at("09:30:00", "2026-11-06"), 5_000), kiwoom(at("15:20:00", "2026-11-06"), 8_000)] });
  collected(scenario, (after) => (after === null ? FLOW : day({ source: "flow", cursor: "f:1:2", reset: false })), past);
  await openBrokers(page, scenario);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
  await expect(window_(page).getByTestId("brokers-date")).toContainText("11-09");
  await expect(window_(page).getByTestId("brokers-date")).toContainText("오늘");
  await expect(window_(page).getByRole("button", { name: "다음 관측일" })).toBeDisabled();
  await window_(page).getByRole("button", { name: "이전 관측일" }).click();
  await expect(window_(page).getByTestId("brokers-date")).toContainText("11-06");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+8,000");
  await expect(window_(page).getByTestId("brokers-time")).toContainText("15:20");
  await expect(window_(page).getByRole("button", { name: "이전 관측일" })).toBeDisabled();
  await page.reload();
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
});

test("커서 시각의 가격이 머리와 건별 표에 보인다", async ({ page, scenario }) => {
  minuteBars(scenario);
  collected(scenario, (after) => (after === null ? FLOW : day({ source: "flow", cursor: "f:1:2", reset: false })));
  await openBrokers(page, scenario);
  await expect(window_(page).getByTestId("brokers-price")).toHaveText("71,300");
  await card(page, "키움").click();
  await page.mouse.move(5, 5);
  await expect(window_(page).getByTestId("broker-detail-row").first()).toContainText("71,300");
  await expect(window_(page).getByTestId("broker-detail")).toContainText("추정가격");
});

test("끊긴 구간은 카드마다 빗금으로 보인다", async ({ page, scenario }) => {
  collected(scenario, (after) => (after === null ? { ...FLOW, gaps: [[at("09:10:00"), at("09:12:00")]] } : day({ source: "flow", cursor: "f:1:2", reset: false, gaps: [[at("09:10:00"), at("09:12:00")]] })));
  await openBrokers(page, scenario);
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(2);
  await expect(window_(page).getByTestId("broker-gap")).toHaveCount(2);
});
