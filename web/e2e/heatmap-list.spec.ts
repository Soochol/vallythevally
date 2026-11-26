import type { Page } from "@playwright/test";
import { HEATMAP_TABLE, heatmapQuote, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { cell, expect, pollSaved, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } as const;
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const listGroup = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 목록` });
const row = (page: Page, code: string) => main(page).locator(`.hm-list-row[data-code="${code}"]`);
const table = (): HeatmapTable => structuredClone(HEATMAP_TABLE);
const watched = (scenario: Scenario, code: string) => scenario.live.messages.some((m) => m.type === "watch" && m.symbols.includes(code));

test("보기 탭은 리스트·히트맵 순서이고 리스트가 기본이며 흐름 비교와 테마 편집 버튼은 없다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?source=kiwoom");
  const tabs = main(page).getByRole("tablist", { name: "보기" }).getByRole("tab");
  await expect(tabs).toHaveText(["리스트", "히트맵"]);
  await expect(main(page).getByRole("tab", { name: "리스트" })).toHaveAttribute("aria-selected", "true");
  await expect(main(page).getByRole("tab", { name: "흐름 비교" })).toHaveCount(0);
  await expect(main(page).getByRole("button", { name: "테마 편집" })).toHaveCount(0);
  await expect(main(page).getByRole("tablist", { name: "테마 출처" })).toHaveCount(0);
  await expect(listGroup(page, "반도체")).toBeVisible();
});

test("리스트 탭은 미니 일봉 캔들 없이 24px 행과 등락 강도 헤더를 보이고 히트맵 전환이 유지된다", async ({ page, scenario }) => {
  const rows: HeatmapTable = {
    "005930": { rate: 4.2, traded: 300_000 },
    "000660": { rate: 3.1, traded: 200_000 },
    "028260": { rate: -0.1, traded: 250_000 },
    "086520": { rate: -0.2, traded: 150_000 },
  };
  seedHeatmapThemes(scenario, rows);
  await page.goto("/heatmap");
  await expect(listGroup(page, "반도체").locator(".hm-list-row")).toHaveCount(2);
  await expect(listGroup(page, "지주").locator(".hm-list-row")).toHaveCount(2);
  await expect(row(page, "005930")).toContainText("삼성전자");
  await expect(row(page, "005930")).toContainText("+4.20%");
  await expect(row(page, "005930")).toContainText("3,000억");
  await expect(main(page).locator(".hm-candle-svg")).toHaveCount(0);
  const rowBox = (await row(page, "005930").boundingBox())!;
  expect(rowBox.height).toBeLessThanOrEqual(25);

  await expect(listGroup(page, "반도체").locator(".hm-list-head")).toHaveAttribute("data-side", "up");
  await expect(listGroup(page, "반도체").locator(".hm-list-head")).toHaveAttribute("data-level", "3");
  await expect(listGroup(page, "지주").locator(".hm-list-head")).toHaveAttribute("data-level", "0");

  const barRequests = scenario.requests
    .map((req) => new URL(req.url()))
    .filter((url) => url.pathname === "/api/bars" && url.searchParams.get("period") === "D" && url.searchParams.get("limit") === "15");
  expect(barRequests).toHaveLength(0);

  await main(page).getByRole("tab", { name: "히트맵" }).click();
  await expect(page).toHaveURL(/[?&]view=board(&|$)/);
  await expect(main(page).getByRole("region", { name: "반도체 지도" })).toBeVisible();
  await page.reload();
  await expect(main(page).getByRole("tab", { name: "히트맵" })).toHaveAttribute("aria-selected", "true");
  await expect(main(page).getByRole("region", { name: "반도체 지도" })).toBeVisible();
});

test("리스트 뷰에서 검색·정렬·접기 펼치기와 실시간 시세 갱신이 동작한다", async ({ page, scenario }) => {
  const rows = table();
  rows["000660"] = { rate: -1, traded: 500_000 };
  seedHeatmapThemes(scenario, rows);
  await page.goto("/heatmap");
  await expect(row(page, "005930")).toBeVisible();
  await pollSaved(() => watched(scenario, "000660")).toBe(true);

  const orderOf = () => listGroup(page, "반도체").locator(".hm-list-row").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.code));
  await expect.poll(orderOf).toEqual(["005930", "000660"]);

  await main(page).getByRole("group", { name: "종목 정렬" }).getByRole("button", { name: "거래대금" }).click();
  await expect(page).toHaveURL(/[?&]sort=traded(&|$)/);
  await expect.poll(orderOf).toEqual(["000660", "005930"]);

  await main(page).getByRole("group", { name: "종목 정렬" }).getByRole("button", { name: "이름" }).click();
  await expect(page).toHaveURL(/[?&]sort=name(&|$)/);
  await expect.poll(orderOf).toEqual(["005930", "000660"]);

  await main(page).getByRole("group", { name: "종목 정렬" }).getByRole("button", { name: "내 순서" }).click();
  await expect(page).toHaveURL(/[?&]sort=custom(&|$)/);
  await expect.poll(orderOf).toEqual(["005930", "000660"]);

  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [{ ...heatmapQuote("000660", { rate: 6.5, traded: 500_000 }, "realtime"), price: 215_000 }] });
  await expect(row(page, "000660")).toContainText("215,000");
  await expect(row(page, "000660")).toContainText("+6.50%");

  const search = main(page).getByRole("searchbox", { name: "종목·테마 검색" });
  await search.fill("삼성전자");
  await expect(listGroup(page, "반도체").locator(".hm-list-row")).toHaveCount(1);
  await expect(listGroup(page, "지주")).toHaveCount(0);

  await search.fill("없는종목XYZ");
  await expect(main(page).getByText("조건에 맞는 종목이 없습니다")).toBeVisible();
  await main(page).getByRole("button", { name: "검색 지우기" }).click();
  await expect(listGroup(page, "지주").locator(".hm-list-row")).toHaveCount(2);

  await listGroup(page, "반도체").locator(".hm-list-head").click();
  await expect(listGroup(page, "반도체").locator(".hm-list-row")).toHaveCount(0);
  await listGroup(page, "반도체").locator(".hm-list-head").click();
  await expect(listGroup(page, "반도체").locator(".hm-list-row")).toHaveCount(2);

  await row(page, "005930").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("리스트 행을 누르면 고른 연동 색 차트에 종목이 열리고 작업 영역으로 간다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  const layout = scenario.documents.layout();
  const second = { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } as const;
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: [...withFirstChart(layout, { link: "a", symbol: "005930", venue: "combined" }), second] });
  const ui = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...ui, pageLink: "b", revision: ui.revision + 1 });
  await page.goto("/heatmap");
  await row(page, "028260").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: 삼성물산/);
});
