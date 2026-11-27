import type { Page } from "@playwright/test";
import type { AccountStatus } from "../src/api/generated/AccountStatus";
import type { LayoutWindow } from "../src/api/generated/LayoutWindow";
import { DENSITY_STORAGE_KEY } from "../src/persist/density";
import { SYNCED } from "./fixtures/scenario";
import { allResult } from "./fixtures/screener";
import { cell, expect, type Scenario, test } from "./screener-harness";
import { openScreener, rows as resultRows, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "regular"), DENSITY_STORAGE_KEY);
});

const FOUR = ["005930", "086520", "005935", "000660"];
const SIGNED_IN: AccountStatus = {
  state: "signed_in",
  provider: "google",
  accountId: "0123456789abcdef0123",
  signedInAt: 1_762_650_000,
  sync: SYNCED,
};

const watchPanel = (page: Page, id = "watchlist") => page.locator(`[role=tabpanel][data-window-id="${id}"]`);
const row = (page: Page, code: string, id = "watchlist") => watchPanel(page, id).locator(`li[data-code="${code}"]`);
const pressHead = (page: Page, count: number, id = "watchlist") => watchPanel(page, id).getByText(`${count}종목`, { exact: true }).first().click();
const showsSymbol = (page: Page, name: string) => expect(cell(page)).toHaveAttribute("aria-label", new RegExp(`^칸 1: ${name} `));

function seedWatchlist(scenario: Scenario, symbols: string[]) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: layout.windows.map((w) => (w.kind === "chart" || w.kind === "watchlist" ? { ...w, link: "a" } : w)),
  });
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "L", name: "기본", symbols, groups: [] }] });
}

test("설정 마법사가 열려 있으면 방향키가 뒤쪽 관심종목을 바꾸지 않는다", async ({ scenario, page }) => {
  scenario.live.account = SIGNED_IN;
  seedWatchlist(scenario, FOUR);
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "086520")).toContainText("에코프로");
  await expect(row(page, "005935")).toContainText("삼성전자우");

  await pressHead(page, 4);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");

  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "시스템 설정", exact: true });
  await settings.getByRole("tab", { name: "계정", exact: true }).click();
  await settings.getByRole("button", { name: "셋업 마법사 다시 열기" }).click();
  const wizard = page.getByRole("dialog", { name: "처음 설정", exact: true });
  await expect(wizard).toBeVisible();

  await wizard.getByRole("heading", { name: "처음 설정" }).click();
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");

  await wizard.getByRole("button", { name: "차트 보기" }).click();
  await expect(wizard).toHaveCount(0);
  await pressHead(page, 4);
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
});

test("다른 탭의 닫기를 눌러도 관심종목 방향키가 이어지고 탭 목록에서 고른 관심종목은 바로 활성이다", async ({ scenario, page }) => {
  seedWatchlist(scenario, FOUR);
  const layout = scenario.documents.layout();
  const chart = layout.windows.find((w) => w.kind === "chart")!;
  const watch = layout.windows.find((w) => w.kind === "watchlist")!;
  const extras: LayoutWindow[] = Array.from({ length: 7 }, (_, i) => ({
    id: i === 0 ? "screener" : `screener-${i + 1}`,
    link: null,
    kind: "screener",
  }));
  const rightTabs = [watch.id, ...extras.map((w) => w.id)];
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: [chart, watch, ...extras],
    placement: {
      v: 1,
      canvas: null,
      dock: {
        floats: [],
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.65,
          first: { kind: "group", id: "g1", tabs: [chart.id], active: chart.id },
          second: { kind: "group", id: "g2", tabs: rightTabs, active: watch.id },
        },
      },
    },
  });

  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "086520")).toContainText("에코프로");
  await expect(row(page, "005935")).toContainText("삼성전자우");

  const rightGroup = page.locator('[data-dock-group="g2"]');
  await expect(rightGroup.getByRole("button", { name: "탭 8개", exact: true })).toBeVisible();

  await pressHead(page, 4);
  const inactiveGroup = rightGroup.locator('.dock-tab-group:has([data-window-id="screener"])');
  await inactiveGroup.hover();
  await inactiveGroup.locator(".dock-tab-close").click();
  await expect(rightGroup.locator('[role=tab][data-window-id="screener"]')).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");

  await rightGroup.locator('[role=tab][data-window-id="screener-2"]').click();
  await expect(watchPanel(page)).toHaveCount(0);

  await rightGroup.getByRole("button", { name: "탭 7개", exact: true }).click();
  await page.getByRole("menu", { name: "탭 목록" }).getByRole("menuitemradio", { name: "관심종목", exact: true }).click();
  await expect(watchPanel(page)).toBeVisible();

  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");
});

test("관심종목 창이 둘이면 마지막으로 누른 창의 목록만 움직이고 스크리너를 누르면 스크리너가 움직인다", async ({ scenario, screener, page }) => {
  const result = allResult();
  scenario.documents.saveWatchlists({
    revision: 100,
    lists: [
      { id: "L1", name: "첫째", symbols: ["005930", "086520"], groups: [] },
      { id: "L2", name: "둘째", symbols: ["005935", "000660"], groups: [] },
    ],
  });
  scenario.documents.saveScreens({ revision: 1, screens: [{ id: "all", name: "모든 종목", markets: [], exclude: [], conditions: [] }] });
  screener.showResult(result);

  const layout = scenario.documents.layout();
  const chart: LayoutWindow = { ...layout.windows.find((w) => w.kind === "chart")!, link: "a" };
  const screen: LayoutWindow = { ...layout.windows.find((w) => w.kind === "screener")!, link: "a" };
  const watch1: LayoutWindow = { id: "watchlist", link: "a", kind: "watchlist", list: "L1" };
  const watch2: LayoutWindow = { id: "watchlist-2", link: "a", kind: "watchlist", list: "L2" };
  scenario.documents.saveLayout({
    ...layout,
    revision: layout.revision + 1,
    windows: [chart, watch1, watch2, screen],
    placement: {
      v: 1,
      canvas: null,
      dock: {
        floats: [],
        root: {
          kind: "split",
          dir: "row",
          ratio: 0.34,
          first: { kind: "group", id: "g1", tabs: [chart.id], active: chart.id },
          second: {
            kind: "split",
            dir: "row",
            ratio: 0.5,
            first: {
              kind: "split",
              dir: "column",
              ratio: 0.5,
              first: { kind: "group", id: "g2", tabs: [watch1.id], active: watch1.id },
              second: { kind: "group", id: "g3", tabs: [watch2.id], active: watch2.id },
            },
            second: { kind: "group", id: "g4", tabs: [screen.id], active: screen.id },
          },
        },
      },
    },
  });

  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(row(page, "086520", "watchlist")).toContainText("에코프로");
  await expect(row(page, "005935", "watchlist-2")).toContainText("삼성전자우");

  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await runButton(page).click();
  await expect(resultRows(page)).toHaveCount(result.rows.length);

  await pressHead(page, 2, "watchlist");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "에코프로");

  await pressHead(page, 2, "watchlist-2");
  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, "삼성전자우");

  const firstResult = resultRows(page).nth(0);
  const secondResult = resultRows(page).nth(1);
  const firstName = (await firstResult.locator("b").textContent())!;
  const secondName = (await secondResult.locator("b").textContent())!;
  await firstResult.getByRole("button").click();
  await showsSymbol(page, firstName);

  await page.keyboard.press("ArrowDown");
  await showsSymbol(page, secondName);
});
