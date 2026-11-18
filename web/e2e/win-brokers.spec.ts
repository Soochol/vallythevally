import type { Page } from "@playwright/test";
import type { FeedBrokers } from "../src/api/generated/FeedBrokers";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { type Scenario, cell, DEFAULT_LAYOUT_ID, expect, pickDesktopVenue, test, windowTabs, pollSaved } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const at = (clock: string) => Date.parse(`2026-11-09T${clock}+09:00`) / 1000;
const entry = (code: string, name: string, qty: number) => ({ code, name, qty, qtyChange: 0 });

const FIRST: FeedBrokers = { t: at("09:30:00"), buys: [entry("151", "키움", 100), entry("152", "미래", 40)], sells: [entry("141", "삼성", 90)] };
const SECOND: FeedBrokers = { t: at("09:31:00"), buys: [entry("151", "키움", 400), entry("152", "미래", 60)], sells: [entry("141", "삼성", 120)] };
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

test("거래원 창은 처음 스냅샷 묶음과 실시간 스냅샷을 행으로 쌓고 슬라이더로 누적값을 옮긴다", async ({ page, scenario }) => {
  await openBrokers(page, scenario);
  send(scenario, FIRST);
  send(scenario, SECOND);
  await expect(window_(page).getByTestId("brokers-since")).toContainText("09:30:00부터");
  await expect(window_(page).getByTestId("broker-row")).toHaveText(["키움", "삼성", "미래"]);
  const cumulative = window_(page).getByTestId("broker-cumulative");
  await expect(cumulative).toHaveText(["+400주", "−120주", "+60주"]);

  send(scenario, LIVE);
  await expect(window_(page).getByTestId("broker-row")).toHaveText(["키움", "한투", "삼성", "미래"]);
  await expect(cumulative).toHaveText(["+700주", "−500주", "−130주", "+60주"]);

  const slider = window_(page).getByRole("slider", { name: "기준 시각" });
  await slider.fill("0");
  await expect(window_(page).getByTestId("brokers-time")).toHaveText("09:30:00");
  await expect(cumulative).toHaveText(["+100주", "-", "−90주", "+40주"]);
});

test("행을 누르면 그 거래원의 누적선이 열리고 숫자는 캔버스 안에 있다", async ({ page, scenario }) => {
  await openBrokers(page, scenario);
  send(scenario, FIRST);
  send(scenario, SECOND);
  send(scenario, LIVE);
  await expect(window_(page).getByTestId("broker-row")).toHaveCount(4);
  await expect(window_(page).getByTestId("broker-line")).toHaveCount(0);

  await window_(page).getByTestId("broker-row").first().click();
  const line = window_(page).getByTestId("broker-line");
  await expect(line).toHaveAttribute("data-broker", "151");
  await expect(line).toContainText("키움 누적 순매수");

  const frame = await window_(page).boundingBox();
  const values = window_(page).getByTestId("broker-cumulative");
  for (let i = 0; i < 4; i++) {
    const box = await values.nth(i).boundingBox();
    expect(box && frame && box.x >= frame.x && box.x + box.width <= frame.x + frame.width).toBe(true);
  }
  await expect(window_(page).getByTestId("brokers-canvas")).toBeVisible();
});

test("거래소가 KRX이면 통합 값이라고 표시하고 범례를 보인다", async ({ page, scenario }) => {
  await openBrokers(page, scenario);
  send(scenario, FIRST);
  await expect(window_(page).getByTestId("broker-row")).toHaveCount(3);
  const tab = windowTabs(page).getByRole("tab", { name: /^거래원 입체분석/ });
  await expect(tab.locator(".mw-integrated")).toHaveCount(0);
  await pickDesktopVenue(page, "KRX");
  await expect(tab.locator(".mw-integrated")).toHaveText("통합");
  await expect(window_(page).locator(".mw-integrated")).toHaveCount(0);
  await expect(window_(page).getByLabel("범례")).toContainText("상위 5위 밖");
});
