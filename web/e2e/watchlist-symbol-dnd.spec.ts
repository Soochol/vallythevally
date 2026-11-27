import type { Locator, Page } from "@playwright/test";
import { DEFAULT_LAYOUT_ID, expect, firstChart, test, type Scenario } from "./harness";

const watchPanel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const watchRow = (page: Page, code: string) => watchPanel(page).locator(`li[data-code="${code}"]`);

async function dragSymbolTo(source: Locator, target: Locator) {
  await source.dragTo(target);
}

async function seedLayout(scenario: Scenario) {
  scenario.reply("/api/trading/auto-orders", { body: { masterEnabled: false, rules: [], events: [] } });
  for (const code of ["005930", "086520", "005935", "000660", "035420", "035720"]) {
    scenario.reply(`/api/symbols/${code}/order-book`, {
      body: { symbol: code, venue: "krx", asks: [], bids: [], totalAsk: 0, totalBid: 0, t: 1793952000 },
    });
    scenario.reply(`/api/symbols/${code}/trades`, { body: { symbol: code, venue: "combined", trades: [] } });
    scenario.reply(`/api/symbols/${code}/fundamentals`, { body: { symbol: code, marketCap: null, per: null, pbr: null, eps: null, bps: null, shares: null } });
  }
  const currentWatchlists = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({
    revision: currentWatchlists.revision + 1,
    lists: [{ id: "main", name: "기본", symbols: ["005930", "086520", "005935"] }],
  });
  const currentLayout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const baseChart = firstChart(currentLayout);
  scenario.documents.saveLayout({
    ...currentLayout,
    revision: currentLayout.revision + 1,
    windows: [
      { ...baseChart, id: "chart-1", link: "a", symbol: "005930" },
      { ...baseChart, id: "chart-2", link: "a", symbol: "005930" },
      { id: "book-1", link: "b", kind: "book" },
      { id: "tape_matrix", link: null, kind: "tape_matrix" },
      { id: "watchlist", link: "a", kind: "watchlist" },
    ],
    placement: {
      v: 1,
      dock: {
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.25,
          first: { kind: "group", id: "g-watch", tabs: ["watchlist"], active: "watchlist" },
          second: {
            kind: "split",
            dir: "row",
            ratio: 0.5,
            first: { kind: "group", id: "g-charts", tabs: ["chart-1", "book-1"], active: "chart-1" },
            second: { kind: "group", id: "g-right", tabs: ["chart-2", "tape_matrix"], active: "chart-2" },
          },
        },
        floats: [],
      },
      canvas: null,
    },
  });
}

test("관심종목에서 연동 차트에 드롭하면 그 차트만 무그룹으로 독립 변경된다", async ({ scenario, page }) => {
  await seedLayout(scenario);
  await page.goto("/");
  await expect(watchRow(page, "086520")).toBeVisible();

  const chartPanel = page.locator('[data-dock-group="g-charts"] .dock-panel');
  await dragSymbolTo(watchRow(page, "086520"), chartPanel);

  await expect(page.locator("#window-tab-chart-1")).toContainText("에코프로");
  await expect(page.locator("#window-tab-chart-2")).toContainText("삼성전자");
});

test("관심종목에서 비활성 보조창 탭에 드롭하면 탭이 활성화되고 종목이 고정된다", async ({ scenario, page }) => {
  await seedLayout(scenario);
  await page.goto("/");
  await expect(watchRow(page, "005935")).toBeVisible();

  const bookTab = page.locator("#window-tab-book-1");
  await dragSymbolTo(watchRow(page, "005935"), bookTab);

  await expect(bookTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-dock-group="g-charts"] .window-symbol[data-pinned]')).toBeVisible();
});

test("관심종목에서 호가 미니 그리드 탭에 드롭하면 종목 카드가 추가된다", async ({ scenario, page }) => {
  await seedLayout(scenario);
  await page.goto("/");
  await expect(watchRow(page, "086520")).toBeVisible();

  const matrixTab = page.locator("#window-tab-tape_matrix");
  await dragSymbolTo(watchRow(page, "086520"), matrixTab);

  await expect(matrixTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tape-card-086520")).toBeVisible();
});

test("관심종목 내부 드래그 순서 변경이 기존대로 동작한다", async ({ scenario, page }) => {
  await seedLayout(scenario);
  await page.goto("/");
  await expect(watchRow(page, "005935")).toBeVisible();

  await dragSymbolTo(watchRow(page, "005935"), watchRow(page, "005930"));
  await expect.poll(() =>
    watchPanel(page).locator("li[data-code]").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code"))),
  ).toEqual(["005935", "005930", "086520"]);
});
