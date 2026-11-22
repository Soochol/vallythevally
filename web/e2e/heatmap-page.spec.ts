import type { Locator, Page } from "@playwright/test";
import { HEATMAP_TABLE, heatmapQuote, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { cell, expect, pollSaved, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const SETTINGS = { v: 1, style: "candle", scale: "normal", indicators: [], compare: [], panels: [] } as const;
const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const group = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 지도` });
const tile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);
const legend = (page: Page) => main(page).getByRole("img", { name: /^색 범위/ });
const fill = (target: Locator) => target.evaluate((el) => (el as HTMLElement).style.background);
const table = (): HeatmapTable => structuredClone(HEATMAP_TABLE);
const watched = (scenario: Scenario, code: string) => scenario.live.messages.some((m) => m.type === "watch" && m.symbols.includes(code));

test("테마마다 타일 지도가 보이고 칸 색이 등락률 부호를 따른다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(group(page, "반도체").locator(".hm-tile")).toHaveCount(2);
  await expect(group(page, "지주").locator(".hm-tile")).toHaveCount(2);
  await expect(tile(page, "005930")).toHaveAttribute("data-side", "up");
  await expect(tile(page, "028260")).toHaveAttribute("data-side", "up");
  await expect(tile(page, "000660")).toHaveAttribute("data-side", "down");
  await expect(tile(page, "086520")).toHaveAttribute("data-side", "down");
  await expect(tile(page, "005930")).toHaveAccessibleName("삼성전자 +2.00%");
  await expect(tile(page, "086520")).toHaveAccessibleName("에코프로 −4.00%");
  await expect(legend(page)).toHaveAccessibleName("색 범위 −8%에서 +8%");
  await expect(main(page).getByRole("status", { name: "자료 신선도" })).toContainText("시세");
  await expect(legend(page)).toContainText("칸 색 = 등락률");
  await expect(legend(page)).toContainText("시세 없음");
  const big = (await tile(page, "005930").boundingBox())!;
  const small = (await tile(page, "000660").boundingBox())!;
  expect(big.width * big.height).toBeGreaterThan(small.width * small.height);
});

test("색 범위를 ±3으로 바꾸면 범례와 칸 색이 바뀌고 주소에 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect(tile(page, "005930")).toBeVisible();
  const before = await fill(tile(page, "005930"));
  await main(page).getByRole("group", { name: "색 범위" }).getByRole("button", { name: "±3%" }).click();
  await expect(legend(page)).toHaveAccessibleName("색 범위 −3%에서 +3%");
  await expect.poll(() => fill(tile(page, "005930"))).not.toBe(before);
  await expect(page).toHaveURL(/[?&]range=3(&|$)/);
  await page.reload();
  await expect(legend(page)).toHaveAccessibleName("색 범위 −3%에서 +3%");
  await expect(main(page).getByRole("group", { name: "색 범위" }).getByRole("button", { name: "±3%" })).toHaveAttribute("aria-pressed", "true");
});

test("크기 기준과 칸 정렬은 주소에 남고 정렬 기준을 글자로 보인다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?size=equal&sort=name");
  await expect(tile(page, "005930")).toBeVisible();
  const a = (await tile(page, "005930").boundingBox())!;
  const b = (await tile(page, "000660").boundingBox())!;
  expect(a.width * a.height).toBeCloseTo(b.width * b.height, 0);
  await expect(main(page).getByText("칸 정렬: 이름 가나다순")).toBeVisible();
  await main(page).getByRole("group", { name: "칸 정렬" }).getByRole("button", { name: "거래대금" }).click();
  await expect(main(page).getByText(/칸 정렬: 거래대금 높은 순/)).toBeVisible();
  await expect(page).toHaveURL(/sort=traded/);
  await main(page).getByRole("group", { name: "칸 크기" }).getByRole("button", { name: "거래대금" }).click();
  await expect(page).not.toHaveURL(/size=/);
});

test("실시간 프레임은 칸 색을 바로 바꾸지만 자리는 1분마다 다시 받는 보드로만 바뀐다", async ({ page, scenario }) => {
  const rows = table();
  const asked = seedHeatmapThemes(scenario, rows);
  await page.clock.install({ time: scenario.now });
  await page.goto("/heatmap?size=equal&order=custom");
  await expect(tile(page, "000660")).toHaveAttribute("data-side", "down");
  await pollSaved(() => watched(scenario, "000660")).toBe(true);
  const fetched = asked.length;
  const first = (await tile(page, "005930").boundingBox())!;
  const second = (await tile(page, "000660").boundingBox())!;
  expect(first.x).toBeLessThan(second.x);

  rows["000660"] = { rate: 9, traded: 200_000 };
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [heatmapQuote("000660", rows["000660"], "realtime")] });
  await expect(tile(page, "000660")).toHaveAttribute("data-side", "up");
  await expect(tile(page, "000660")).toHaveAccessibleName("SK하이닉스 +9.00%");
  expect(await tile(page, "000660").boundingBox()).toEqual(second);
  expect(await tile(page, "005930").boundingBox()).toEqual(first);
  expect(asked).toHaveLength(fetched);

  await page.clock.runFor(61_000);
  await pollSaved(() => asked.length).toBeGreaterThan(fetched);
  await expect.poll(async () => (await tile(page, "000660").boundingBox())!.x).toBe(first.x);
  expect((await tile(page, "005930").boundingBox())!.x).toBe(second.x);
});

test("칸을 누르면 고른 연동 색 차트에 그 종목이 열리고 작업 영역으로 간다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  const layout = scenario.documents.layout();
  const second = { id: "cell-1", link: "b", kind: "chart", symbol: "000660", venue: "combined", period: "D", chartSettings: SETTINGS } as const;
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: [...withFirstChart(layout, { link: "a", symbol: "005930", venue: "combined" }), second] });
  const ui = scenario.documents.uiState();
  scenario.documents.saveUiState({ ...ui, pageLink: "b", revision: ui.revision + 1 });
  await page.goto("/heatmap");
  await expect(page.getByRole("button", { name: "보낼 연동 색: B" })).toBeVisible();
  await tile(page, "028260").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /^칸 2: 삼성물산/);
  await expect(cell(page, 1)).toHaveAttribute("aria-label", /^칸 1: 삼성전자/);
});

test("테마 머리에 거래대금 가중 평균과 거래대금 합, 상승·하락 수, 대장주가 보인다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  const chips = group(page, "반도체");
  await expect(chips.getByLabel(/^거래대금 가중 평균/)).toHaveAccessibleName("거래대금 가중 평균 +0.80%");
  await expect(chips.getByLabel(/^거래대금 가중 평균/)).toHaveAttribute("data-side", "up");
  const summary = chips.getByLabel("테마 요약");
  await expect(summary).toContainText("거래대금 5,000억");
  await expect(summary).toContainText("상승 1 · 보합 0 · 하락 1");
  await expect(summary).toContainText("대장주 삼성전자");
  await expect(tile(page, "005930")).toHaveAttribute("title", "삼성전자 +2.00%\n005930 · 거래대금 3,000억 · 반도체 안 비중 60.0%");
});

test("테마 순서는 기본이 가중 평균 등락률 높은 순이고 바꾸면 주소에 남는다", async ({ page, scenario }) => {
  const asked = seedHeatmapThemes(scenario, table());
  const titles = () => main(page).locator(".hm-group h2").allTextContents();
  await page.goto("/heatmap");
  await expect.poll(titles).toEqual(["지주", "반도체"]);
  const order = main(page).getByRole("group", { name: "테마 순서" });
  await order.getByRole("button", { name: "내 순서" }).click();
  await expect.poll(titles).toEqual(["반도체", "지주"]);
  await expect(page).toHaveURL(/[?&]order=custom(&|$)/);
  await order.getByRole("button", { name: "거래대금" }).click();
  await expect.poll(titles).toEqual(["반도체", "지주"]);
  await order.getByRole("button", { name: "가중 평균 등락률" }).click();
  await expect.poll(titles).toEqual(["지주", "반도체"]);
  await expect(page).not.toHaveURL(/order=/);
  expect(asked).toEqual(expect.arrayContaining(["rate", "custom", "traded"]));
});

test("시세를 받지 못한 종목은 빈 칸으로 남고 요약에서 뺐다고 알린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "999990"] }] });
  await page.goto("/heatmap");
  await expect(tile(page, "999990")).toHaveAttribute("data-side", "none");
  await expect(group(page, "반도체").getByRole("note")).toHaveText("시세를 받지 못해 요약에서 뺀 종목: 999990");
  await expect(group(page, "반도체").getByLabel("테마 요약")).toContainText("상승 1 · 보합 0 · 하락 0");
});

test("테마가 없으면 테마를 만들라고 안내한다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [] });
  await page.goto("/heatmap");
  await expect(main(page).getByText("테마가 없습니다")).toBeVisible();
  await expect(main(page).getByText(/테마마다 지도를 그립니다/)).toBeVisible();
  await expect(main(page).locator(".hm-tile")).toHaveCount(0);
});
