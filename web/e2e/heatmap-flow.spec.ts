import type { Page } from "@playwright/test";
import { HEATMAP_FLOWS, HEATMAP_TABLE, flowSeries, seedHeatmapFlow, seedHeatmapThemes } from "./fixtures/heatmap-data";
import { expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const line = (page: Page, group?: string) => main(page).locator(group ? `.hm-flow-line[data-group="${group}"]` : ".hm-flow-line");
const toggle = (page: Page, name: string) => main(page).getByRole("group", { name: "테마 표시" }).getByRole("button", { name });

test("흐름 비교로 바꾸면 테마마다 선이 있고 주소에 보기가 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  const asked = seedHeatmapFlow(scenario, HEATMAP_FLOWS);
  await page.goto("/heatmap");
  await main(page).getByRole("tab", { name: "흐름 비교" }).click();
  await expect(line(page)).toHaveCount(2);
  await expect(line(page, "chips")).toBeVisible();
  await expect(line(page, "holding")).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=flow(&|$)/);
  await expect(main(page).getByRole("img", { name: "테마별 장중 가중 평균 등락률" }).getByText("반도체 +2.10%")).toBeVisible();
  await expect(main(page).getByRole("img", { name: "테마별 장중 가중 평균 등락률" }).getByText("지주 −0.20%")).toBeVisible();
  expect(asked.toSorted()).toEqual(["005930,000660", "028260,086520"]);

  await page.reload();
  await expect(main(page).getByRole("tab", { name: "흐름 비교" })).toHaveAttribute("aria-selected", "true");
  await expect(line(page)).toHaveCount(2);

  await main(page).getByRole("tab", { name: "보드" }).click();
  await expect(main(page).getByRole("region", { name: "반도체 지도" })).toBeVisible();
  await expect(page).not.toHaveURL(/view=/);
});

test("범례에서 테마를 끄면 그 선이 사라지고 다시 켜면 돌아온다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  seedHeatmapFlow(scenario, HEATMAP_FLOWS);
  await page.goto("/heatmap?view=flow");
  await expect(line(page)).toHaveCount(2);
  await expect(toggle(page, "지주")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle(page, "지주")).toHaveAccessibleName("지주 −0.20%");

  await toggle(page, "지주").click();
  await expect(toggle(page, "지주")).toHaveAttribute("aria-pressed", "false");
  await expect(line(page, "holding")).toHaveCount(0);
  await expect(line(page, "chips")).toHaveCount(1);

  await toggle(page, "지주").click();
  await expect(line(page, "holding")).toHaveCount(1);
});

test("범례 점과 보드 테마 머리 점은 같은 테마 색이다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  seedHeatmapFlow(scenario, HEATMAP_FLOWS);
  await page.goto("/heatmap");
  const boardDot = (name: string) => main(page).getByRole("region", { name: `${name} 지도` }).locator(".hm-group-dot").evaluate((el) => (el as HTMLElement).style.background);
  const legendDot = (name: string) => toggle(page, name).locator("i").evaluate((el) => (el as HTMLElement).style.background);
  const board = [await boardDot("반도체"), await boardDot("지주")];
  expect(board[0]).not.toBe(board[1]);
  await main(page).getByRole("tab", { name: "흐름 비교" }).click();
  await expect(line(page)).toHaveCount(2);
  expect([await legendDot("반도체"), await legendDot("지주")]).toEqual(board);
});

test("응답에 빠진 종목이 있으면 그 사실이 보인다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  seedHeatmapFlow(scenario, { ...HEATMAP_FLOWS, "028260,086520": flowSeries([-0.4, 0.3], ["028260"], { missing: ["086520"] }) });
  await page.goto("/heatmap?view=flow");
  await expect(line(page)).toHaveCount(2);
  await expect(main(page).getByText("지주: 분봉을 받지 못해 평균에서 뺀 종목 에코프로")).toBeVisible();
  await expect(main(page).getByText(/반도체: 분봉을 받지 못해/)).toHaveCount(0);
});

test("종목 수 상한을 넘어 계산에서 빠진 종목도 보인다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  seedHeatmapFlow(scenario, { ...HEATMAP_FLOWS, "005930,000660": flowSeries([0.5, 1.2], ["005930"], { overLimit: ["000660"], limit: 1 }) });
  await page.goto("/heatmap?view=flow");
  await expect(main(page).getByText("반도체: 한 번에 1종목까지만 계산해 뒤의 1종목(SK하이닉스)은 뺐습니다")).toBeVisible();
});

test("한 테마를 계산하지 못하면 그 테마만 알리고 나머지 선은 남는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  const { "028260,086520": _dropped, ...onlyChips } = HEATMAP_FLOWS;
  seedHeatmapFlow(scenario, onlyChips);
  await page.goto("/heatmap?view=flow");
  await expect(line(page, "chips")).toBeVisible();
  await expect(main(page).getByRole("alert").filter({ hasText: "지주: 흐름을 계산하지 못했습니다" })).toBeVisible();
  await expect(line(page, "holding")).toHaveCount(0);
});

test("1분마다 흐름을 다시 받는다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  const asked = seedHeatmapFlow(scenario, HEATMAP_FLOWS);
  await page.clock.install({ time: scenario.now });
  await page.goto("/heatmap?view=flow");
  await expect(line(page)).toHaveCount(2);
  expect(asked).toHaveLength(2);
  await page.clock.runFor(61_000);
  await expect.poll(() => asked.length).toBe(4);
});

test("오늘 분봉이 아직 없으면 그릴 흐름이 없다고 알린다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, structuredClone(HEATMAP_TABLE));
  seedHeatmapFlow(scenario, { "005930,000660": flowSeries([], ["005930", "000660"]), "028260,086520": flowSeries([], ["028260", "086520"]) });
  await page.goto("/heatmap?view=flow");
  await expect(main(page).getByText(/그릴 흐름이 없습니다/)).toBeVisible();
  await expect(line(page)).toHaveCount(0);
});
