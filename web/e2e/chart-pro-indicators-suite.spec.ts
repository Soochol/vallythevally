import type { Layout } from "../src/api/generated/Layout";
import { cell, DEFAULT_LAYOUT_ID, expect, test, withFirstChart, type Scenario } from "./harness";

test.use({ clockStart: "20261109100030" });

function seedProIndicators(scenario: Scenario, indicators: object[], panels: object[]) {
  const current: Layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const { id, name, sync, placement, revision } = current;
  const chartSettings = { v: 2, style: "candle", scale: "normal", indicators, compare: [], panels };
  scenario.documents.saveLayout({
    id,
    name,
    sync,
    placement,
    revision: revision + 1,
    windows: withFirstChart(current, { symbol: "005930", venue: "combined", period: "1m", chartSettings }),
  });
}

test("프로 트레이더 보조지표 4종이 차트 레전드에 정상 표시된다", async ({ page, scenario }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  seedProIndicators(
    scenario,
    [
      { id: "av1", spec: { kind: "anchoredVwap", priceSource: "hlc3", showBands: true, anchorPreset: "open", anchorTime: null }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
      { id: "vp1", spec: { kind: "volumeProfile", mode: "vrvp", bins: 32, showDelta: true, valueAreaPct: 70 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 1 } },
      { id: "tv1", spec: { kind: "tapeVelocity", metric: "tps", showStrength: true }, panel: "p1", visible: true, style: { colors: ["ind-3"], width: 1 } },
      { id: "fb1", spec: { kind: "foreignBrokerFlow", source: "auto", displayMode: "both" }, panel: "p2", visible: true, style: { colors: ["ind-4"], width: 1 } },
    ],
    [{ id: "p1", stretch: 0.25 }, { id: "p2", stretch: 0.25 }],
  );
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.locator('[data-indicator-row="av1"]')).toContainText("기준점 VWAP");
  await expect(page.locator('[data-indicator-row="vp1"]')).toContainText("매물대");
  await expect(page.locator('[data-indicator-row="tv1"]')).toContainText("체결강도 & 체결속도");
  await expect(page.locator('[data-indicator-row="fb1"]')).toContainText("외국계 추정 순매수");
  expect(errors).toEqual([]);
});
