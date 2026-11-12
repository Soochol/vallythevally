import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { installChartProbe } from "./chart-probe";
import { type App, cell, DEFAULT_LAYOUT_ID, expect, test } from "./harness";

const row = (page: Page, id: string) => cell(page).locator(`[data-indicator-row="${id}"]`);
const layout = async (app: App): Promise<Layout> => (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();

async function open(page: Page, app: App, height = 900, stretches = Array.from({ length: 6 }, () => 0.25)) {
  const saved = await layout(app);
  const chartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: [
    ...[5, 20].map((period, i) => ({ id: `ma${i}`, spec: { kind: "ma", method: "sma", period }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } })),
    ...stretches.map((_, i) => ({ id: `rsi${i}`, spec: { kind: "rsi", period: 14, signal: null }, panel: `p${i}`, visible: true, style: { colors: ["ind-2"], width: 1 } })),
  ], panels: stretches.map((stretch, i) => ({ id: `p${i}`, stretch })) };
  expect((await fetch(`${app.url}/api/layouts/${saved.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...saved, revision: saved.revision + 1, cells: [{ ...saved.cells[0], symbol: "005930", venue: "combined", period: "D", chartSettings }] }) })).ok).toBe(true);
  await page.setViewportSize({ width: 1440, height });
  await page.addInitScript(installChartProbe);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(cell(page).locator("[data-indicator-row]")).toHaveCount(8);
  await expect.poll(() => page.evaluate(() => window.chartProbe?.chart.panes().length)).toBe(7);
}

async function panes(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.chartProbe.chart.panes().map((pane) => ({ height: pane.getHeight(), stretch: pane.getStretchFactor() }));
  });
}

for (const height of [300, 900]) {
  test(`높이 ${height}의 6개 패널은 손잡이 극한 조절에서도 양수와 인접 높이 합을 지킨다`, async ({ page, app }) => {
    await open(page, app, height);
    for (const below of [2, 1]) {
      const handle = cell(page).locator(`[data-panel-resize="p${below - 1}"]`);
      const before = await panes(page);
      const pairHeight = before[below - 1]!.height + before[below]!.height;
      const pairShare = (before[below - 1]!.stretch + before[below]!.stretch) / before.reduce((sum, pane) => sum + pane.stretch, 0);
      const verify = async () => {
        const after = await panes(page);
        expect(after.every((pane) => Number.isFinite(pane.stretch) && pane.stretch > 0)).toBe(true);
        expect((after[below - 1]!.stretch + after[below]!.stretch) / after.reduce((sum, pane) => sum + pane.stretch, 0)).toBeCloseTo(pairShare, 10);
        expect(after[below - 1]!.height + after[below]!.height).toBe(pairHeight);
        expect(after.filter((_, i) => i !== below - 1 && i !== below).map((pane) => pane.height)).toEqual(before.filter((_, i) => i !== below - 1 && i !== below).map((pane) => pane.height));
        if (pairHeight < (below === 1 ? 80 : 48) + 48) expect(after).toEqual(before);
      };
      await handle.focus();
      for (const key of ["ArrowDown", "ArrowUp"]) {
        for (let i = 0; i < 12; i++) await page.keyboard.press(key);
        await verify();
      }
      for (const delta of [1000, -1000]) {
        const box = await handle.boundingBox();
        if (!box) throw new Error("패널 손잡이가 없습니다");
        const x = box.x + box.width * 0.65;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x, y + delta, { steps: 10 }); await page.mouse.up();
        await verify();
      }
      const rest = await panes(page);
      const box = await handle.boundingBox();
      if (!box) throw new Error("패널 손잡이가 없습니다");
      const x = box.x + box.width * 0.65;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x, y + 16, { steps: 3 });
      await page.mouse.move(x, y, { steps: 3 }); await page.mouse.up();
      expect((await panes(page)).map((pane) => pane.height)).toEqual(rest.map((pane) => pane.height));
    }
  });
}

test("음수·0으로 저장된 패널 높이는 다른 설정을 보존하며 기본 비율로 복구한다", async ({ page, app }) => {
  await open(page, app, 900, [-0.1, 0, 0.3, 0.3, 0.3, 0.3]);
  const shown = await panes(page);
  expect(shown.map((pane) => pane.stretch)).toEqual([1, 0.25, 0.25, 0.3, 0.3, 0.3, 0.3]);
  await row(page, "ma1").hover();
  await row(page, "ma1").getByRole("button", { name: /숨기기/ }).click();
  await expect.poll(async () => (await layout(app)).cells[0]?.chartSettings).toMatchObject({ panels: [{ id: "p0", stretch: 0.25 }, { id: "p1", stretch: 0.25 }, { id: "p2", stretch: 0.3 }, { id: "p3", stretch: 0.3 }, { id: "p4", stretch: 0.3 }, { id: "p5", stretch: 0.3 }] });
});

test("같은 지표 이름을 다시 눌러도 Esc는 처음 연 설정으로 돌아간다", async ({ page, app }) => {
  await open(page, app);
  const name = row(page, "ma0").getByRole("button", { name: /설정 열기/ });
  await name.click();
  const popup = page.getByRole("dialog", { name: "이동평균 단순 5 설정", exact: true });
  await popup.getByRole("textbox", { name: "기간", exact: true }).fill("9");
  await expect(row(page, "ma0")).toContainText("단순 9");
  await name.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row(page, "ma0")).toContainText("단순 5");
  await expect.poll(async () => (await layout(app)).cells[0]?.chartSettings).toMatchObject({ indicators: [ { id: "ma0", spec: { period: 5 } }, { id: "ma1", spec: { period: 20 } }, ...Array.from({ length: 6 }, (_, i) => ({ id: `rsi${i}` })) ] });
});

test("다른 지표 이름은 한 번 눌러 전환하고 각 창의 Esc 원본을 따로 유지한다", async ({ page, app }) => {
  await open(page, app);
  await row(page, "ma0").hover();
  await row(page, "ma0").getByRole("button", { name: "이동평균 단순 5 설정", exact: true }).click();
  await page.getByRole("dialog", { name: "이동평균 단순 5 설정", exact: true }).getByRole("textbox", { name: "기간", exact: true }).fill("9");
  await expect(row(page, "ma0")).toContainText("단순 9");
  await row(page, "ma1").getByRole("button", { name: /설정 열기/ }).click();
  const next = page.getByRole("dialog", { name: "이동평균 단순 20 설정", exact: true });
  await expect(next).toBeVisible();
  await expect(next.getByRole("textbox", { name: "기간", exact: true })).toHaveValue("20");
  await next.getByRole("textbox", { name: "기간", exact: true }).fill("25");
  await expect(row(page, "ma1")).toContainText("단순 25");
  await page.keyboard.press("Escape");
  await expect(row(page, "ma0")).toContainText("단순 9");
  await expect(row(page, "ma1")).toContainText("단순 20");
  await row(page, "ma0").getByRole("button", { name: /설정 열기/ }).click();
  await page.getByRole("dialog", { name: "이동평균 단순 9 설정", exact: true }).getByRole("textbox", { name: "기간", exact: true }).fill("11");
  await page.keyboard.press("Escape");
  await expect(row(page, "ma0")).toContainText("단순 9");
});
