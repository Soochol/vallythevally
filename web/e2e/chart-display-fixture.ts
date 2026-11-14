import type { BarsPage } from "../src/api/generated/BarsPage";
import type { FinancialPeriod } from "../src/api/generated/FinancialPeriod";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { ChartSettings } from "../src/chart/settings";
import { DEFAULT_LAYOUT_ID, type Scenario } from "./harness";
import { financialPage } from "./financial-update-helpers";

const METRICS = ["owner_roe", "investing_cash_flow", "dps", "debt_ratio"] as const;

export function chartDisplayFinancials(period: FinancialPeriod): FinancialsPage {
  const page = financialPage("000660", period);
  page.series = page.series.map(series => ({ ...series, points: series.points.map(point => {
    if (point.value === null) return point;
    if (series.metric === "investing_cash_flow") {
      const value = point.businessYear === 2016 ? -48_054_251_000_000 : -1_648_000_000;
      return { ...point, value: period === "Q" && point.reportCode !== "11013" ? 0 : value, reportedValue: value };
    }
    if (series.metric === "dps") return { ...point, value: 2000, reportedValue: 2000 };
    return point;
  }) }));
  return page;
}

export function chartDisplayBars(period: FinancialPeriod, years = 4): BarsPage {
  const bars = Array.from({ length: years * (period === "Y" ? 1 : 4) }, (_, i) => {
    const year = 2018 - years + (period === "Y" ? i : Math.floor(i / 4));
    const month = period === "Y" ? 1 : i % 4 * 3 + 1;
    const day = `${year}-${String(month).padStart(2, "0")}-01`;
    return { t: Date.parse(`${day}T00:00:00+09:00`) / 1000, o: 1_277_000, h: 1_302_000, l: 1_271_000, c: 1_296_000, v: period === "Q" ? 9_360_000 : 3_120_000 };
  });
  return { symbol: "000660", venue: "combined", period, bars, current: null, nextBefore: null, seq: null };
}

export async function seedChartDisplay(scenario: Scenario, period: FinancialPeriod) {
  for (const value of ["Q", "Y"] as const) {
    scenario.reply(url => url.pathname === "/api/symbols/000660/financials" && url.searchParams.get("period") === value, { body: chartDisplayFinancials(value) });
    scenario.reply(url => url.pathname === "/api/bars" && url.searchParams.get("symbol") === "000660" && url.searchParams.get("period") === value, { body: chartDisplayBars(value) });
  }
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", visibleBars: null, showExtremes: false, showOhlc: true, showOhlcChange: false, extremeBasis: "last", compare: [], indicators: METRICS.map(kind => ({
    id: kind, spec: { kind }, panel: kind, visible: true, style: { colors: ["ind-1"], width: 1 },
  })), panels: METRICS.map(id => ({ id, stretch: 0.3 })) };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0]!, symbol: "000660", venue: "combined", period, chartSettings }] });
}

export const chartDisplayOptions = {};
