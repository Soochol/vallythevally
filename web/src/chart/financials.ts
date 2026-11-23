import type { FinancialInput } from "../api/generated/FinancialInput";
import type { FinancialMetric } from "../api/generated/FinancialMetric";
import type { FinancialPoint } from "../api/generated/FinancialPoint";
import type { FinancialReason } from "../api/generated/FinancialReason";
import type { FinancialReportingPeriod } from "../api/generated/FinancialReportingPeriod";
import type { FinancialsPage } from "../api/generated/FinancialsPage";
import type { UnixSeconds } from "../api/generated/UnixSeconds";

const REASON: Record<FinancialReason, string> = {
  annual_only: "연간 전용", share_class_unverified: "배당 주식 종류 미확인", account_mapping_unverified: "계정 의미 미확인",
  ambiguous_account: "계정 자료가 서로 다름", amount_missing: "금액 없음", period_unverified: "실제 보고기간 미확인",
  period_mismatch: "보고기간 불일치", short_period: "결산 변경 등으로 짧아진 보고기간", period_overlap: "같은 가격봉에 보고기간이 겹쳐 표시 불가",
  missing_comparison: "필요한 비교기간 자료 없음", basis_changed: "연결·별도 기준 변경", currency_mismatch: "통화 불일치",
  non_positive_equity: "자본총계가 0 이하", non_positive_average_equity: "평균 지배주주 지분이 0 이하",
  non_finite_result: "표시할 수 없는 계산값", receipt_mismatch: "공시 접수번호 불일치", refresh_incomplete: "비교기간 갱신 미완료",
};
const STATUS: Record<string, string> = {
  available: "확인", unpublished: "미공시", missing_item: "항목 없음", not_calculable: "산출 불가", failed: "조회 실패", pending: "수집 대기",
  unsupported: "재무지표 미지원", missing_report: "비교 보고서 없음", not_configured: "이 서버에 재무자료가 없습니다",
  not_collected: "미수집",
  ready: "확인 완료", stale: "저장 자료 · 갱신 대기", partial_failure: "일부 조회 실패",
};
const FAILURE: Record<string, string> = {
  authentication: "DART 인증 설정 확인 필요", network: "자료원 연결 실패", rate_limited: "자료원 조회 한도 초과", remote: "자료원 응답 오류",
  invalid_response: "자료 형식 확인 불가", storage: "재무자료 저장 실패", source_unavailable: "공식 자료원 확인 불가", receipt_mismatch: "공시 접수번호 불일치",
};
export const financialFailure = (failure: string | null) => failure ? FAILURE[failure] ?? "자료 조회 실패" : "";
const SOURCE_REASON: Record<string, string> = {
  company_mapping_unverified: "공식 회사 연결 미확인", preferred_issue_class_unverified: "우선주 배당 종류 미확인",
  etf: "ETF는 가격 차트만 제공합니다", index: "업종지수는 가격 차트만 제공합니다", unsupported_product: "가격 차트만 제공하는 상품입니다",
};
export const financialReason = (reason: FinancialReason | null) => reason ? REASON[reason] : "";
export const financialStatus = (status: string) => STATUS[status] ?? status;
const KST_OFFSET_SECONDS = 9 * 3600;
export const checkedTime = (t: UnixSeconds | null) => t === null ? "아직 없음" : new Date((t + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 16).replace("T", " ");

export const reportingPeriod = (p: FinancialReportingPeriod | null): string => p === null ? "실제 보고기간 미확인" : p.kind === "instant" ? `${p.date} 기말` : `${p.start} ~ ${p.end}`;
export const financialUnit = (metric: FinancialMetric, currency: string | null) => metric === "owner_roe" || metric === "debt_ratio" ? "%" : metric === "dps" ? "원/주" : currency ?? "통화 미확인";
export const financialValue = (v: number, metric: FinancialMetric, currency: string | null) => `${v.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} ${financialUnit(metric, currency)}`;

export interface FinancialDetailRow { readonly name: string; readonly value: string }

const detailRow = (name: string, value: string): FinancialDetailRow => ({ name, value });
const joined = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");
const basisText = (basis: FinancialPoint["basis"]) => basis === "CFS" ? "연결" : basis === "OFS" ? "별도" : "기준 미확인";

function financialSummaryStatus(page: FinancialsPage): string {
  const { failed } = page.progress;
  const saved = page.series.some((series) => series.points.some((point) => point.value !== null || point.inputs.some((input) => input.lastSuccessAt !== null)));
  return joined(financialStatus(page.status), page.reason && (SOURCE_REASON[page.reason] ?? (page.status === "unsupported" ? "이 상품은 가격 차트만 제공합니다" : "회사 자료 미확인")),
    failed > 0 && `실패 ${failed}건`,
    (page.failure || page.disclosureFailure) && (saved ? "갱신 실패 · 저장 자료 유지" : "조회 실패 · 다시 시도하세요"));
}

export function financialSummary(page: FinancialsPage): string {
  return joined(financialSummaryStatus(page), `마지막 확인 ${checkedTime(page.lastCheckedAt)}`);
}

export function financialSummaryRows(page: FinancialsPage): FinancialDetailRow[] {
  return [detailRow("상태", financialSummaryStatus(page)), detailRow("마지막 확인", checkedTime(page.lastCheckedAt))];
}

const INPUT_USAGE: Record<FinancialInput["usage"], string> = { value: "원금액", comparison: "비교기간", reporting_period: "배당 보고기간 근거" };

function inputRows(i: FinancialInput): FinancialDetailRow[] {
  const account = i.fields.account_nm ?? i.fields.se ?? i.fields.account_id ?? (i.role === "statement" ? "보고서" : i.role);
  const failure = i.failure ? i.lastSuccessAt !== null ? "갱신 실패 (저장 자료)" : "조회 실패" : null;
  return [
    detailRow(INPUT_USAGE[i.usage], `${i.businessYear} / ${i.reportCode}`),
    detailRow(account, [i.amount ?? "—", i.currency].filter(Boolean).join(" ")),
    detailRow("상태", joined(financialStatus(i.status), financialReason(i.reason))),
    detailRow("보고기간", reportingPeriod(i.period)),
    detailRow("기준", basisText(i.basis)),
    detailRow("공시일", i.disclosedAt ?? "미확인"),
    detailRow("접수번호", i.receipt ?? "미확인"),
    detailRow("조회", checkedTime(i.checkedAt)),
    detailRow("마지막 성공", joined(checkedTime(i.lastSuccessAt), failure)),
    ...(i.failure ? [detailRow("실패", financialFailure(i.failure))] : []),
    ...(i.verificationReason ? [detailRow("기간 검증", i.verificationReason)] : []),
  ];
}

export function financialDetailRows(point: FinancialPoint, metric: FinancialMetric): FinancialDetailRow[] {
  return [
    detailRow("보고서", `${point.businessYear} / ${point.reportCode}`),
    detailRow("보고기간", reportingPeriod(point.period)),
    detailRow("상태", joined(financialStatus(point.status), financialReason(point.reason))),
    detailRow("기준", joined(basisText(point.basis), point.currency ?? "통화 미확인")),
    detailRow("표시값", point.value === null ? "—" : financialValue(point.value, metric, point.currency)),
    ...(point.reportedValue !== null && point.reason === "period_overlap" ? [detailRow("원래 보고값", `${financialValue(point.reportedValue, metric, point.currency)} · 합산하지 않음`)] : []),
    ...point.inputs.flatMap(inputRows),
  ];
}

export function financialBuckets(points: readonly FinancialPoint[]): Map<UnixSeconds, FinancialPoint[]> {
  const buckets = new Map<UnixSeconds, FinancialPoint[]>();
  for (const p of points) if (p.priceBucket !== null) buckets.set(p.priceBucket, [...(buckets.get(p.priceBucket) ?? []), p]);
  return buckets;
}

export function adjacentBucket(a: number, b: number, period: "Q" | "Y"): boolean {
  const date = new Date((a + 9 * 3600) * 1000);
  date.setUTCMonth(date.getUTCMonth() + (period === "Q" ? 3 : 12));
  return date.getTime() / 1000 - 9 * 3600 === b;
}
