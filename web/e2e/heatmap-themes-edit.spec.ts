import type { Page } from "@playwright/test";
import { HEATMAP_TABLE, seedHeatmapThemes, type HeatmapTable } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000" });

const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const listGroup = (page: Page, name: string) => main(page).getByRole("region", { name: `${name} 목록` });
const table = (): HeatmapTable => structuredClone(HEATMAP_TABLE);
const stored = (scenario: Scenario) => scenario.documents.heatmapThemes();
const storedShape = (scenario: Scenario) => stored(scenario).themes.map((theme) => [theme.name, theme.symbols]);
const toast = (page: Page) => page.locator(".ui-toast").last();
const groupNames = (page: Page) => main(page).locator(".hm-list-group .hm-list-title h2").allTextContents();
const rowCodes = (page: Page, themeName: string) => listGroup(page, themeName).locator(".hm-list-row").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.code));

test("그룹 헤더를 끌어 놓으면 내 순서로 자동 전환되며 위치가 저장된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap");
  await expect.poll(() => groupNames(page)).toEqual(["지주", "반도체"]);
  await listGroup(page, "반도체").locator(".hm-list-head").dragTo(listGroup(page, "지주"), { targetPosition: { x: 10, y: 12 } });
  await expect(page).toHaveURL(/[?&]order=custom(&|$)/);
  await expect.poll(() => groupNames(page)).toEqual(["반도체", "지주"]);
  await pollSaved(() => storedShape(scenario).map(([name]) => name)).toEqual(["반도체", "지주"]);
});

test("종목을 같은 그룹 안에서 끌어 순서를 바꾸면 내 순서로 자동 전환되고 호버 빼기 뒤 되돌리기로 복원된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table(), { revision: 100, themes: [{ id: "chips", name: "반도체", symbols: ["005930", "000660", "028260"] }] });
  await page.goto("/heatmap");
  const rowOf = (code: string) => listGroup(page, "반도체").locator(`.hm-list-row[data-code="${code}"]`);
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["028260", "005930", "000660"]);

  await rowOf("000660").dragTo(rowOf("028260"), { targetPosition: { x: 40, y: 2 } });
  await expect(page).toHaveURL(/[?&]sort=custom(&|$)/);
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "028260", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "028260", "005930"]]]);

  await rowOf("028260").hover();
  await rowOf("028260").getByRole("button", { name: "삼성물산 빼기" }).click();
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "005930"]]]);

  await toast(page).getByRole("button", { name: /되돌리기/ }).click();
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["000660", "028260", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["000660", "028260", "005930"]]]);
});

test("종목을 다른 그룹으로 끌면 이동하고 Shift+드래그하면 복제된다", async ({ page, scenario }) => {
  seedHeatmapThemes(scenario, table());
  await page.goto("/heatmap?order=custom&sort=custom");
  const rowIn = (themeName: string, code: string) => listGroup(page, themeName).locator(`.hm-list-row[data-code="${code}"]`);

  await rowIn("반도체", "000660").dragTo(rowIn("지주", "086520"), { targetPosition: { x: 40, y: 20 } });
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["005930"]);
  await expect.poll(() => rowCodes(page, "지주")).toEqual(["028260", "086520", "000660"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930"]], ["지주", ["028260", "086520", "000660"]]]);

  await page.keyboard.down("Shift");
  await rowIn("반도체", "005930").dragTo(rowIn("지주", "000660"), { targetPosition: { x: 40, y: 20 } });
  await page.keyboard.up("Shift");
  await expect.poll(() => rowCodes(page, "반도체")).toEqual(["005930"]);
  await expect.poll(() => rowCodes(page, "지주")).toEqual(["028260", "086520", "000660", "005930"]);
  await pollSaved(() => storedShape(scenario)).toEqual([["반도체", ["005930"]], ["지주", ["028260", "086520", "000660", "005930"]]]);
});
