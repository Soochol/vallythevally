import type { Page } from "@playwright/test";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs, pollSaved } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
test.use({ clockStart: "20261109093230" });

const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });

const FIRST: FeedBrokers = { t: at("09:30:00"), buys: [entry("151", "키움", 100), entry("152", "미래", 40)], sells: [entry("141", "삼성", 90)] };
const SECOND: FeedBrokers = { t: at("09:31:00"), buys: [entry("151", "키움", 400), entry("152", "미래", 60)], sells: [entry("141", "삼성", 120)] };
const FOREIGN: FeedBrokers = { t: at("09:33:00"), buys: [entry("151", "키움", 700), entry("033", "JP모간", 250)], sells: [entry("141", "삼성", 130), entry("143", "한투", 500)] };
const LIVE: FeedBrokers = { t: at("09:32:00"), buys: [entry("151", "키움", 700)], sells: [entry("141", "삼성", 130), entry("143", "한투", 500)] };

function linkedChart(scenario: Scenario) {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });
}

async function openBrokers(page: Page, scenario: Scenario) {
  linkedChart(scenario);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^거래원 입체분석/ }).click();
  await expect(windowTabs(page).getByRole("tab", { name: /^거래원 입체분석/ })).toHaveCount(1);
  await pollSaved(() => scenario.live.messages.some((m) => m.type === "subscribe_feed" && m.kind === "brokers")).toBe(true);
}

function send(scenario: Scenario, brokers: FeedBrokers) {
  const request = scenario.live.messages.find((m) => m.type === "subscribe_feed" && m.kind === "brokers");
  if (request?.type !== "subscribe_feed") throw new Error("거래원 구독이 없습니다");
  scenario.live.emit({ type: "feed_brokers", sub: request.sub, brokers });
}

const window_ = (page: Page) => page.getByTestId("brokers-window");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

const savedBrokers = (scenario: Scenario) => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.find((w) => w.kind === "brokers");
const card = (page: Page, name: string) => window_(page).getByTestId("broker-card").and(page.locator(`[data-broker="${name}"]`));
const cardNames = (page: Page) => window_(page).getByTestId("broker-card").evaluateAll((cards) => cards.map((c) => c.getAttribute("data-broker")));

async function openWithThree(page: Page, scenario: Scenario) {
  await openBrokers(page, scenario);
  for (const brokers of [FIRST, SECOND, LIVE]) send(scenario, brokers);
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(4);
}

test("입체는 거래원마다 카드이고 막대와 숫자를 함께 보인다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  await expect.poll(() => cardNames(page)).toEqual(["키움", "한투", "삼성", "미래"]);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+700");
  await expect(card(page, "한투").getByTestId("broker-cumulative")).toHaveText("−500");
  await expect(window_(page).getByTestId("broker-bars")).toHaveCount(4);
  await expect(window_(page).getByTestId("broker-numbers")).toHaveCount(4);
  await expect(card(page, "키움").getByTestId("broker-numbers")).toContainText("+300");
  await expect(window_(page).getByRole("group", { name: "보기" }).getByRole("button", { name: "입체" })).toHaveAttribute("aria-pressed", "true");
});

test("카드 모양 단추로 막대와 숫자를 바꾸고 창을 다시 열어도 기억한다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  const shape = window_(page).getByRole("group", { name: "카드 모양" });
  await shape.getByRole("button", { name: "막대", exact: true }).click();
  await expect(window_(page).getByTestId("broker-numbers")).toHaveCount(0);
  await expect(window_(page).getByTestId("broker-bars")).toHaveCount(4);
  await shape.getByRole("button", { name: "숫자", exact: true }).click();
  await expect(window_(page).getByTestId("broker-bars")).toHaveCount(0);
  await expect(window_(page).getByTestId("broker-numbers")).toHaveCount(4);
  await pollSaved(() => savedBrokers(scenario)).toMatchObject({ kind: "brokers", cards: "numbers" });
  await page.reload();
  await expect(window_(page).getByRole("group", { name: "카드 모양" }).getByRole("button", { name: "숫자", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("한 카드 막대 위의 시각이 모든 카드의 커서와 누적을 옮긴다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  await expect(window_(page).getByTestId("broker-cursor")).toHaveCount(0);
  const bars = (await card(page, "한투").getByTestId("broker-bars").boundingBox())!;
  await page.mouse.move(bars.x + bars.width * (31.5 / 32.5), bars.y + bars.height / 2);
  await expect(window_(page).getByTestId("broker-cursor")).toHaveCount(4);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+400");
  await expect(card(page, "한투").getByTestId("broker-cumulative")).toHaveText("-");
  await expect(card(page, "미래").getByTestId("broker-cumulative")).toHaveText("+60");
  await expect(window_(page).getByTestId("brokers-time")).toContainText("09:31");
  await page.mouse.move(5, 5);
  await expect(window_(page).getByTestId("broker-cursor")).toHaveCount(0);
  await expect(card(page, "키움").getByTestId("broker-cumulative")).toHaveText("+700");
});

test("카드를 누르면 건별 표가 열린다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  await expect(window_(page).getByTestId("broker-detail")).toHaveCount(0);
  await card(page, "키움").click();
  await expect(card(page, "키움")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(5, 5);
  const rows = window_(page).getByTestId("broker-detail-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("09:32:00");
  await expect(rows.nth(0)).toContainText("+300");
  await expect(rows.nth(0)).toContainText("+700");
  await expect(rows.nth(2)).toContainText("09:30:00");
  await card(page, "키움").click();
  await expect(window_(page).getByTestId("broker-detail")).toHaveCount(0);
});

test("거래원 보기는 순매수 순 궤적과 외국계 합계를 보이고 창마다 기억한다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  await window_(page).getByRole("group", { name: "보기" }).getByRole("button", { name: "거래원" }).click();
  await expect(window_(page).getByTestId("broker-name")).toHaveText(["키움", "미래", "삼성", "한투"]);
  await expect(window_(page).getByTestId("broker-cumulative")).toHaveText(["+700", "+60", "−130", "−500"]);
  await expect(window_(page).getByTestId("broker-sell-divider")).toHaveCount(1);
  await expect(window_(page).getByTestId("broker-foreign-sum")).toHaveText("-");
  send(scenario, FOREIGN);
  await expect(window_(page).getByTestId("broker-foreign-sum")).toHaveText("+250");
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(0);
  await pollSaved(() => savedBrokers(scenario)).toMatchObject({ kind: "brokers", view: "list" });
});

test("통합 표시와 스냅샷 안내 문구가 없다", async ({ page, scenario }) => {
  await openBrokers(page, scenario);
  send(scenario, FIRST);
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(3);
  await pickDesktopVenue(page, "KRX");
  const tab = windowTabs(page).getByRole("tab", { name: /^거래원 입체분석/ });
  await expect(tab).toHaveCount(1);
  await expect(tab.locator(".mw-integrated")).toHaveCount(0);
  await expect(window_(page).locator(".mw-integrated")).toHaveCount(0);
  await expect(window_(page)).not.toContainText("받은 스냅샷만");
  await expect(window_(page).getByRole("slider")).toHaveCount(0);
});

test("기본 보기는 매도·매수 상위 5개 표와 외국계 순매수를 보이고 새로고침 뒤에도 기억한다", async ({ page, scenario }) => {
  await openWithThree(page, scenario);
  send(scenario, FOREIGN);
  const viewGroup = window_(page).getByRole("group", { name: "보기" });
  await expect(viewGroup.getByRole("button")).toHaveText(["입체", "거래원", "기본"]);
  await viewGroup.getByRole("button", { name: "기본", exact: true }).click();

  await expect(window_(page).getByTestId("broker-table")).toBeVisible();
  await expect(window_(page).getByTestId("broker-table-row")).toHaveCount(5);
  await expect(window_(page).getByTestId("broker-card")).toHaveCount(0);
  await expect(window_(page).getByRole("group", { name: "카드 모양" })).toHaveCount(0);
  await expect(window_(page).getByTestId("broker-sell-name").first()).toHaveText("삼성");
  await expect(window_(page).getByTestId("broker-sell-qty").first()).toHaveText("130");
  await expect(window_(page).getByTestId("broker-buy-name").first()).toHaveText("키움");
  await expect(window_(page).getByTestId("broker-buy-qty").first()).toHaveText("700");
  await expect(window_(page).getByTestId("broker-table-totals")).toContainText("630");
  await expect(window_(page).getByTestId("broker-table-totals")).toContainText("950");
  await expect(window_(page).getByTestId("broker-table-foreign")).toContainText("+250");
  await expect(window_(page).getByTestId("broker-table-stamp")).toContainText("09:33:00");

  await pollSaved(() => savedBrokers(scenario)).toMatchObject({ kind: "brokers", view: "table" });
  await page.reload();
  await expect(window_(page).getByRole("group", { name: "보기" }).getByRole("button", { name: "기본", exact: true })).toHaveAttribute("aria-pressed", "true");
});
