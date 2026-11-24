import type { FinancialPeriod } from "../../api/generated/FinancialPeriod";
import type { Period } from "../../api/generated/Period";
import type { ChartSettings, IndicatorConfig, Panel } from "../settings";
import { isIntraday } from "../time";
import { isFinancial, isQuote } from "./kinds";

export interface FinancialRequest {
  period: FinancialPeriod;
  enabled: boolean;
}

const drawsFinancials = (period: Period) => period === "Q" || period === "Y";
const drawsQuotes = (period: Period, stock: boolean) => stock && isIntraday(period);

export function chartIndicators(settings: Pick<ChartSettings, "indicators">, period: Period, stock = true): IndicatorConfig[] {
  return settings.indicators.filter((c) => {
    if (isFinancial(c.spec)) return drawsFinancials(period);
    if (isQuote(c.spec)) return drawsQuotes(period, stock);
    return true;
  });
}

export function chartPanels(settings: Pick<ChartSettings, "indicators" | "panels">, period: Period, stock = true): Panel[] {
  const configs = chartIndicators(settings, period, stock);
  return settings.panels.filter((p) => configs.some((c) => c.panel === p.id));
}

export function financialRequest(period: Period, settings: Pick<ChartSettings, "indicators">): FinancialRequest {
  return {
    period: period === "Y" ? "Y" : "Q",
    enabled: drawsFinancials(period) && settings.indicators.some((c) => isFinancial(c.spec) && c.visible),
  };
}
