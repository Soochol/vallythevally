import type { PriceFormat } from "lightweight-charts";
import type { FinancialsPage } from "../../api/generated/FinancialsPage";
import type { FinancialPoint } from "../../api/generated/FinancialPoint";
import type { Period } from "../../api/generated/Period";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { type AxisGeometry, axisPriceFormat, financialAxisUnit } from "../axisFormat";
import {
  adjacentBucket,
  checkedTime,
  financialBuckets,
  type FinancialDetailRow,
  financialDetailRows,
  financialFailure,
  financialReason,
  financialSummary,
  financialSummaryRows,
  financialValue,
  reportingPeriod,
} from "../financials";
import type { IndicatorConfig } from "../settings";
import { indicatorColorValue, type ThemeTokens } from "../theme";
import { isFinancial, specName } from "./kinds";
import type { FinancialReport, IndicatorRow } from "./layer";

function financialOverviewRows(page: FinancialsPage | null, notice: string | undefined, message: string): FinancialDetailRow[] {
  if (!page) return [{ name: "상태", value: message }];
  const failures = [{ name: "자료 조회", value: financialFailure(page.failure) }, { name: "공시 조회", value: financialFailure(page.disclosureFailure) }].filter((row) => row.value !== "");
  return [
    ...financialSummaryRows(page),
    ...(notice ? [{ name: "안내", value: notice }] : []),
    ...failures,
    { name: "최근 시도", value: checkedTime(page.lastAttemptAt) },
    ...(page.shareClassReason ? [{ name: "배당 주식 종류", value: "미확인 · 회사 재무와 별도로 확인합니다" }] : []),
    ...(page.latestCorrections ? [{ name: "공시 기준", value: "정정된 최신 공시" }] : []),
  ];
}

export class FinancialIndicatorStore {
  private page: FinancialsPage | null = null;
  private reports = new Map<string, FinancialReport[]>();
  private pointRows = new Map<FinancialPoint, readonly FinancialDetailRow[]>();
  private overview: readonly FinancialDetailRow[] = [];
  private summaryText = "";
  private message = "재무자료를 불러오는 중입니다";
  private notice: string | undefined;

  update(page: FinancialsPage | null, message?: string): void {
    this.page = page;
    this.notice = message;
    this.summaryText = page ? financialSummary(page) : "";
    this.pointRows = new Map(page?.series.flatMap((series) => series.points.map((point) => [point, financialDetailRows(point, series.metric)] as const)) ?? []);
    this.reports = new Map(
      page?.series.map((series) => [
        series.metric,
        series.points.map((point) => ({ label: `${point.businessYear} / ${point.reportCode} · ${reportingPeriod(point.period)}`, rows: this.pointRows.get(point) ?? [] })),
      ]) ?? [],
    );
    this.message = message ?? "재무자료를 불러오는 중입니다";
    this.overview = financialOverviewRows(page, message, this.message);
  }

  availablePoints(metric: string): { t: UnixSeconds; v: number }[] {
    const buckets = financialBuckets(this.page?.series.find((series) => series.metric === metric)?.points ?? []);
    return [...buckets].sort(([a], [b]) => a - b).flatMap(([t, ps]) => {
      const p = ps[0];
      return ps.length === 1 && p?.status === "available" && p.value !== null ? [{ t, v: p.value }] : [];
    });
  }

  adjacent(prev: UnixSeconds, next: UnixSeconds, period: Period): boolean {
    return period === "Q" || period === "Y" ? adjacentBucket(prev, next, period) : false;
  }

  priceFormat(config: IndicatorConfig, geometry: AxisGeometry): PriceFormat | null {
    if (!isFinancial(config.spec)) return null;
    const metric = config.spec.kind;
    const currencies = new Set(this.page?.series.find((series) => series.metric === metric)?.points.flatMap((p) => (p.currency ? [p.currency] : [])));
    const currency = currencies.size === 1 ? [...currencies][0] ?? null : "원문 통화";
    return axisPriceFormat(financialAxisUnit(metric, currency), 0.01, geometry);
  }

  row(
    config: IndicatorConfig,
    time: UnixSeconds | null,
    period: Period,
    tokens: ThemeTokens,
    panel: { index: number; count: number; collapsed?: boolean },
    showFiscalMonth: boolean,
  ): IndicatorRow {
    if (!isFinancial(config.spec)) {
      return { id: config.id, name: specName(config.spec), color: tokens.text2, values: [], state: "hidden", panel };
    }
    const metric = config.spec.kind;
    const points = this.page?.series.find((series) => series.metric === metric)?.points ?? [];
    const at = points.filter((p) => p.priceBucket === (panel.collapsed ? points.at(-1)?.priceBucket : time));
    const fiscalMonth = showFiscalMonth && this.page?.fiscalMonth ? ` · ${this.page.fiscalMonth}월 결산` : "";
    const summary = this.page ? [this.summaryText, this.notice].filter(Boolean).join(" · ") : this.message;
    const unitNote = metric === "dps" && period === "Q" ? " · 연간 전용" : "";
    return {
      id: config.id,
      name: `${specName(config.spec)}${fiscalMonth}${unitNote}`,
      color: indicatorColorValue(tokens, config.style.colors[0] ?? "ind-1"),
      values: at.map((p) => ({ text: p.value === null ? financialReason(p.reason) || "—" : financialValue(p.value, metric, p.currency), color: tokens.text2 })),
      state: config.visible ? "ok" : "hidden",
      panel,
      detail: {
        status: this.notice ? "failed" : this.page?.status ?? "pending",
        summary,
        rows: [...this.overview, ...at.flatMap((p) => this.pointRows.get(p) ?? [])],
        reports: this.reports.get(metric) ?? [],
      },
    };
  }
}
