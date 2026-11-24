import type { Page } from "@playwright/test";
import type { BrokerDay } from "../src/api/generated/BrokerDay";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, fixedWait, pollSaved, test, windowTabs } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const TODAY = "20261109";
const PAST = "20261106";
test.use({ clockStart: "20261109093230" });

const at = (clock: string, day = "2026-11-09") => Date.parse(`${day}T${clock}+09:00`) / 1000;
const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });
const kiwoom = (t: number, qty: number): FeedBrokers => ({ t, buys: [entry("151", "키움", qty)], sells: [entry("141", "삼성", 90)] });
const day = (patch: Partial<BrokerDay>): BrokerDay => ({ symbol: "005930", date: TODAY, source: "none", snapshots: [], gaps: [], live: true, cursor: "", reset: true, ...patch });
const window_ = (page: Page) => page.getByTestId("brokers-window");
const card = (page: Page, name: string) => window_(page).getByTestId("broker-card").and(page.locator(`[data-broker="${name}"]`));

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

test("증분이 실패해도 화면을 두고 다음에 이어 받는다", async ({ page, scenario }) => {
  const counts = { polls: 0 };
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const after = new URL(request.url()).searchParams.get("after");
    if (after === null) {
      return { body: day({ source: "flow", snapshots: [kiwoom(at("09:30:00"), 100)], cursor: "f:1:1" }) };
    }
    counts.polls += 1;
    if (counts.polls === 1) {
      return { status: 500, body: { error: { code: "internal", message: "일시 오류", reason: null, retryAt: null, manualActionRequired: false } } };
    }
    if (counts.polls === 2) {
      return { body: day({ source: "flow", snapshots: [kiwoom(at("09:32:00"), 450)], cursor: "f:1:2", reset: false }) };
    }
    return { body: day({ source: "flow", cursor: "f:1:2", reset: false }) };
  });

  await openBrokers(page, scenario);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
  await pollSaved(() => counts.polls).toBeGreaterThanOrEqual(1);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+450");
});

test("다른 페이지에 가 있으면 이어 받기를 멈춘다", async ({ page, scenario }) => {
  const counts = { polls: 0 };
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const after = new URL(request.url()).searchParams.get("after");
    if (after === null) {
      return { body: day({ source: "flow", snapshots: [kiwoom(at("09:30:00"), 100)], cursor: "f:1:1" }) };
    }
    counts.polls += 1;
    return { body: day({ source: "flow", cursor: "f:1:1", reset: false }) };
  });

  await openBrokers(page, scenario);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+100");
  await page.getByRole("link", { name: "히트맵" }).click();
  await expect(page.getByRole("main", { name: "히트맵", exact: true })).toBeVisible();
  const whileAway = counts.polls;
  await fixedWait(page, 2_500, "다른 페이지에 머무는 동안 2초 이어 받기가 멈추는지 확인");
  expect(counts.polls).toBe(whileAway);
  await page.getByRole("link", { name: "작업 영역" }).click();
  await expect(window_(page)).toBeVisible();
  await pollSaved(() => counts.polls).toBeGreaterThan(whileAway);
});

test("과거일을 보고 돌아온 실시간 궤적은 끊긴다", async ({ page, scenario }) => {
  const past = day({ date: PAST, source: "store", live: false, cursor: "s:1:1", snapshots: [kiwoom(at("09:30:00", "2026-11-06"), 500)] });
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers/days", () => ({ body: { symbol: "005930", days: [PAST] } }));
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", (request) => {
    const date = new URL(request.url()).searchParams.get("date");
    return { body: date === PAST ? past : day({ date: TODAY, source: "none", live: false }) };
  });

  await openBrokers(page, scenario);
  await pollSaved(() => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "brokers").length).toBe(1);
  const firstSub = scenario.live.messages.findLast((m) => m.type === "subscribe_feed" && m.kind === "brokers");
  if (firstSub?.type !== "subscribe_feed") throw new Error("첫 거래원 구독이 없습니다");
  scenario.live.emit({ type: "feed_brokers", sub: firstSub.sub, brokers: kiwoom(at("09:30:00"), 100) });
  scenario.live.emit({ type: "feed_brokers", sub: firstSub.sub, brokers: kiwoom(at("09:31:00"), 250) });
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+250");

  await window_(page).getByRole("button", { name: "이전 관측일" }).click();
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+500");

  await window_(page).getByRole("button", { name: "다음 관측일" }).click();
  await pollSaved(() => scenario.live.messages.filter((m) => m.type === "subscribe_feed" && m.kind === "brokers").length).toBe(2);
  const secondSub = scenario.live.messages.findLast((m) => m.type === "subscribe_feed" && m.kind === "brokers");
  if (secondSub?.type !== "subscribe_feed") throw new Error("재구독이 없습니다");
  scenario.live.emit({ type: "feed_brokers", sub: secondSub.sub, brokers: kiwoom(at("09:32:00"), 400) });
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+400");

  await window_(page).getByRole("group", { name: "보기" }).getByRole("button", { name: "거래원" }).click();
  const kiwoomRow = window_(page).getByTestId("broker-row").filter({ hasText: "키움" });
  await expect(kiwoomRow.locator("svg line[stroke-dasharray]")).toHaveCount(1);
});

test("거래원을 바꾸면 건별 표는 맨 위부터다", async ({ page, scenario }) => {
  const start = at("09:00:00");
  const snapshots: FeedBrokers[] = Array.from({ length: 200 }, (_, i) => ({
    t: start + i * 10,
    buys: [entry("151", "키움", (i + 1) * 10)],
    sells: [entry("141", "삼성", (i + 1) * 5)],
  }));
  scenario.on((url) => url.pathname === "/api/symbols/005930/brokers", () => ({
    body: day({ source: "store", live: false, snapshots, cursor: "s:1:200" }),
  }));

  await openBrokers(page, scenario);
  await card(page, "키움").click();
  const detail = window_(page).getByTestId("broker-detail");
  await expect(detail).toBeVisible();
  const scroller = detail.locator(".br-det-body");
  await scroller.evaluate((el) => {
    el.scrollTop = 1800;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);

  await card(page, "삼성").click();
  await expect(detail).toContainText("삼성");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(detail.getByTestId("broker-detail-row").first()).toContainText("09:33:10");
  const renderedCount = await detail.getByTestId("broker-detail-row").count();
  expect(renderedCount).toBeLessThan(200);
});
