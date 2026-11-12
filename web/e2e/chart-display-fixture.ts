import type { Layout } from "../src/api/generated/Layout";
import type { ChartSettings } from "../src/chart/settings";
import { type App, DEFAULT_LAYOUT_ID, expect } from "./harness";

const METRICS = ["owner_roe", "investing_cash_flow", "dps", "debt_ratio"] as const;

export async function seedChartDisplay(app: App, period: "Q" | "Y") {
  app.dart!.largeValues = true;
  for (const coarse of ["Q", "Y"] as const) await app.fake.respondWith({ apiId: coarse === "Y" ? "ka10094" : "ka10083", status: 200, body: {
    return_code: 0, return_msg: "synthetic", stk_cd: "000660_AL",
    [coarse === "Y" ? "stk_yr_pole_chart_qry" : "stk_mth_pole_chart_qry"]: Array.from({ length: coarse === "Y" ? 4 : 48 }, (_, i) => {
      const date = new Date(Date.UTC(2017, coarse === "Y" ? 0 : 11 - i, 1));
      if (coarse === "Y") date.setUTCFullYear(2017 - i);
      return { dt: date.toISOString().slice(0, 10).replaceAll("-", ""), open_pric: "1277000", high_pric: "1302000", low_pric: "1271000", cur_prc: "1296000", trde_qty: "3120000" };
    }), _headers: { "cont-yn": "N", "next-key": "" },
  } });
  const layout: Layout = await (await fetch(`${app.url}/api/layouts/${DEFAULT_LAYOUT_ID}`)).json();
  const chartSettings: ChartSettings = { v: 2, style: "candle", scale: "normal", compare: [], indicators: METRICS.map((kind) => ({
    id: kind, spec: { kind }, panel: kind, visible: true, style: { colors: ["ind-1"], width: 1 },
  })), panels: METRICS.map((id) => ({ id, stretch: 0.3 })) };
  const result = await fetch(`${app.url}/api/layouts/${layout.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...layout, revision: layout.revision + 1, cells: [{ ...layout.cells[0], symbol: "000660", venue: "combined", period, chartSettings }] }) });
  expect(result.ok, await result.text()).toBe(true);
}

export const chartDisplayOptions = { financialFixture: true, clockStart: "20171231120000", bootReplies: [{ apiId: "ka10099", status: 200, body: {
  return_code: 0, return_msg: "synthetic", list: [
    { code: "005930", name: "삼성전자", marketCode: "0", marketName: "거래소", kind: "A", state: "증거금20%", nxtEnable: "Y", regDay: "19750611", lastPrice: "70000", listCount: "100000" },
    { code: "000660", name: "SK하이닉스", marketCode: "0", marketName: "거래소", kind: "A", state: "증거금20%", nxtEnable: "Y", regDay: "19961226", lastPrice: "1296000", listCount: "100000" },
  ], _headers: { "cont-yn": "N", "next-key": "" },
} }] };

