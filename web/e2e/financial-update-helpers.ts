import type { Page } from "@playwright/test";
import type { FinancialPeriod } from "../src/api/generated/FinancialPeriod";
import type { FinancialsPage } from "../src/api/generated/FinancialsPage";
import type { FinancialUpdatePage } from "../src/api/generated/FinancialUpdatePage";
import { test as base } from "./frontend-harness";
import type { Scenario } from "./fixtures/scenario";
import { edgeData, preferredDps, readyData, readyJob } from "./fixtures/financial-data";

export { expect } from "./frontend-harness";
export type FinancialMode = "ready" | "edge";
type Action = "start" | "pause" | "resume";

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

export function financialUpdatePage(overrides: Partial<FinancialUpdatePage> = {}): FinancialUpdatePage {
  return { ...structuredClone(readyJob), ...overrides };
}

export class FinancialFixture {
  private mode: FinancialMode = "ready";
  private overrides: Partial<FinancialsPage> = {};
  private symbolOverrides = new Map<string, Partial<FinancialsPage>>();
  private version = 1;
  private jobValue = financialUpdatePage({ id: 0, status: "idle", phase: "planning", completedCompanies: 0, historyCompletedCompanies: 0, historyComplete: false, lastCheckedAt: null });
  private action: ((action: Action) => void) | null = null;

  constructor(readonly scenario: Scenario) {
    scenario.on(url => /\/financials$/.test(url.pathname), request => {
      const url = new URL(request.url());
      const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (symbol === "500095") return { status: 404, body: { error: { code: "unknown_symbol", message: "없는 종목입니다" } } };
      return { body: this.page(symbol, url.searchParams.get("period") === "Q" ? "Q" : "Y") };
    });
    scenario.on(url => url.pathname.startsWith("/api/financial-update"), request => {
      if (request.method() === "POST") {
        const path = new URL(request.url()).pathname;
        const action = path.endsWith("/pause") ? "pause" : path.endsWith("/resume") ? "resume" : "start";
        if (this.action) this.action(action);
        else this.jobValue = financialUpdatePage({ id: this.jobValue.id + 1 });
      }
      return { body: structuredClone(this.jobValue) };
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
  job(overrides: Partial<FinancialUpdatePage> = {}): FinancialUpdatePage { this.jobValue = { ...this.jobValue, ...structuredClone(overrides) }; return structuredClone(this.jobValue); }
  onCommand(action: (action: Action) => void): void { this.action = action; }
}

export const financialTest = base.extend<{ financial: FinancialFixture }>({
  financial: [async ({ scenario }, use) => { await use(new FinancialFixture(scenario)); }, { auto: true }],
});

export async function updateFromChart(page: Page) {
  await page.getByRole("button", { name: "전체 재무자료 업데이트", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "재무자료", exact: true });
  await dialog.getByRole("button", { name: "전체 업데이트", exact: true }).click();
  await dialog.getByRole("button", { name: "닫기", exact: true }).first().click();
}
