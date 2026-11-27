import type { Page } from "@playwright/test";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import type { ServerMessage } from "../src/api/generated/ServerMessage";
import { cell, DEFAULT_LAYOUT_ID, expect, pollSaved, test } from "./harness";

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] };
const addButton = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "창 더하기" });
const kindItem = (page: Page, name: string) => page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: new RegExp(`^${name}`) });

test("고래 체결 창은 실시간 스트림·프리셋·커스텀 금액·종목집계·차트 연동을 지원한다", async ({ page, scenario }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const windows: LayoutWindow[] = [
    { id: "cell-0", link: "a", kind: "chart", symbol: "005930", venue: "combined", period: "D", chartSettings: SETTINGS },
    ...layout.windows.filter((w) => w.kind !== "chart"),
  ];
  scenario.documents.saveLayout({ ...layout, windows, placement: {}, revision: layout.revision + 1 });

  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  await addButton(page).click();
  await kindItem(page, "고래 체결").click();
  await expect(page.getByTestId("whale-window")).toBeVisible();
  await pollSaved(() => scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.some((w) => w.kind === "whale")).toBe(true);

  const snapshot: ServerMessage = {
    type: "whale_snapshot",
    watchedCount: 42,
    events: [
      { id: 2, at: 1_764_205_210, symbol: "000660", side: "buy", price: 196_000, quantity: 1_200, amountWon: 235_200_000 },
      { id: 1, at: 1_764_205_200, symbol: "005930", side: "sell", price: 78_000, quantity: 500, amountWon: 39_000_000 },
    ],
    summaries: [
      { symbol: "000660", buyCount: 1, sellCount: 0, buyWon: 235_200_000, sellWon: 0, netWon: 235_200_000, lastPrice: 196_000, lastAt: 1_764_205_210 },
      { symbol: "005930", buyCount: 0, sellCount: 1, buyWon: 0, sellWon: 39_000_000, netWon: -39_000_000, lastPrice: 78_000, lastAt: 1_764_205_200 },
    ],
  };
  scenario.live.emit(snapshot);

  await expect(page.getByTestId("whale-watched-count")).toContainText("42");
  await expect(page.getByTestId("whale-stream-table").locator("tbody tr")).toHaveCount(1);

  await page.getByTestId("whale-preset-30m").click();
  await expect(page.getByTestId("whale-stream-table").locator("tbody tr")).toHaveCount(2);

  await page.getByTestId("whale-custom-min").fill("2억");
  await expect(page.getByTestId("whale-stream-table").locator("tbody tr")).toHaveCount(1);

  await page.getByTestId("whale-view-rank").click();
  await expect(page.getByTestId("whale-rank-table").locator("tbody tr")).toHaveCount(1);

  await page.getByTestId("whale-rank-table").locator('tbody tr[data-symbol="000660"]').click();
  await expect(cell(page)).toHaveAccessibleName(/SK하이닉스/);
});
