import type { FinancialPeriod } from "../../api/generated/FinancialPeriod";
import type { Period } from "../../api/generated/Period";
import type { ChartSettings, IndicatorConfig, Panel } from "../settings";
import { isFinancial } from "./kinds";

export interface FinancialRequest {
  period: FinancialPeriod;
  enabled: boolean;
}

const drawsFinancials = (period: Period) => period === "Q" || period === "Y";

export function chartIndicators(settings: Pick<ChartSettings, "indicators">, period: Period): IndicatorConfig[] {
  return settings.indicators.filter((c) => !isFinancial(c.spec) || drawsFinancials(period));
}

export function chartPanels(settings: Pick<ChartSettings, "indicators" | "panels">, period: Period): Panel[] {
  const configs = chartIndicators(settings, period);
  return settings.panels.filter((p) => configs.some((c) => c.panel === p.id));
}

export function financialRequest(period: Period, settings: Pick<ChartSettings, "indicators">): FinancialRequest {
  return {
    period: period === "Y" ? "Y" : "Q",
    enabled: drawsFinancials(period) && settings.indicators.some((c) => isFinancial(c.spec) && c.visible),
  };
}
