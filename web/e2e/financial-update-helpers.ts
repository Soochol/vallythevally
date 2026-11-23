import type { FinancialPeriod } from "../src/api/generated/FinancialPeriod";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import { test as base } from "./harness";
import type { Scenario } from "./fixtures/scenario";
import { edgeData, preferredDps, readyData } from "./fixtures/financial-data";

export { expect } from "./harness";
import { withFirstChart } from "./harness";
export type FinancialMode = "ready" | "edge";

export function financialPage(symbol = "005930", period: FinancialPeriod = "Y", mode: FinancialMode = "ready"): FinancialsPage {
  const page = structuredClone((mode === "edge" ? edgeData : readyData)[period]);
  page.symbol = symbol;
  if (symbol === "000020") { page.fiscalMonth = 3; page.corpCode = "00000002"; }
  if (symbol === "005935") {
    page.shareClass = "preferred";
    const dps = page.series.find(series => series.metric === "dps");
    if (dps && period === "Y") dps.points = structuredClone(preferredDps);
  }
  if (symbol === "0000D0" || symbol.startsWith("IDX:")) {
    page.status = "unsupported";
    page.reason = "unsupported_product";
    page.series = page.series.map(series => ({ ...series, points: [] }));
  }
  return page;
}

export class FinancialFixture {
  private mode: FinancialMode = "ready";
  private overrides: Partial<FinancialsPage> = {};
  private symbolOverrides = new Map<string, Partial<FinancialsPage>>();
  private version = 1;

  constructor(readonly scenario: Scenario) {
    scenario.on(url => /\/financials$/.test(url.pathname), request => {
      const url = new URL(request.url());
      const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (symbol === "500095") return { status: 404, body: { error: { code: "unknown_symbol", message: "없는 종목입니다" } } };
      return { body: this.page(symbol, url.searchParams.get("period") === "Q" ? "Q" : "Y") };
    });
    for (const symbol of [{ code: "000020", name: "동화약품", kind: "common", market: "kospi", nxtEnabled: false }, { code: "0000D0", name: "합성 ETF", kind: "etf", market: "kospi", nxtEnabled: false }]) scenario.reply(`/api/symbols/${symbol.code}`, { body: symbol });
    scenario.on("/api/symbols", request => {
      const url = new URL(request.url());
      const query = url.searchParams.get("q") ?? "";
      const extra = query.includes("000020") || query.includes("동화") ? [{ code: "000020", name: "동화약품", kind: "common", market: "kospi", nxtEnabled: false }] : [];
      return { body: [...scenario.market.search(query), ...extra] };
    });
  }
  page(symbol = "005930", period: FinancialPeriod = "Y"): FinancialsPage {
    return { ...financialPage(symbol, period, this.mode), refreshVersion: this.version, disclosureVersion: this.version, ...structuredClone(this.overrides), ...structuredClone(this.symbolOverrides.get(symbol) ?? {}) };
  }
  show(mode: FinancialMode = "ready", overrides: Partial<FinancialsPage> = {}): void { this.mode = mode; this.overrides = structuredClone(overrides); this.version++; }
  forSymbol(symbol: string, overrides: Partial<FinancialsPage>): void { this.symbolOverrides.set(symbol, structuredClone(overrides)); }
}

export const financialTest = base.extend<{ financial: FinancialFixture }>({
  financial: [async ({ scenario }, use) => { await use(new FinancialFixture(scenario)); }, { auto: true }],
});

export function seedFinancialLayout(scenario: Scenario) {
  const layout = scenario.documents.layout();
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, windows: withFirstChart(layout, { symbol: "005930", venue: "combined", period: "Y", chartSettings: { v: 2, style: "candle", scale: "normal", compare: [], indicators: [{ id: "revenue", spec: { kind: "revenue" }, panel: "revenue", visible: true, style: { colors: ["ind-2"], width: 1 } }], panels: [{ id: "revenue", stretch: 0.4 }] } }) });
}
