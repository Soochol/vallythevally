import { expect, test } from "vitest";
import type { FinancialPoint } from "../api/generated/FinancialPoint";
import type { FinancialsPage } from "../api/generated/FinancialsPage";
import { adjacentBucket, financialBuckets, financialDetail, financialSummary, financialValue } from "./financials";
import { addIndicator, DEFAULT_CHART_SETTINGS, movePanel, parseChartSettings, setPanelStretches, updateIndicator } from "./settings";

const kst = (date: string) => Date.parse(`${date}T00:00:00+09:00`) / 1000;
const point: FinancialPoint = { businessYear: 2024, reportCode: "11011", status: "not_calculable", reason: "non_positive_equity", value: null, reportedValue: null, period: { kind: "instant", date: "2024-12-31" }, priceBucket: kst("2024-01-01"), basis: "CFS", currency: "KRW", inputs: [] };

test("재무지표도 같은 패널·표시·순서·높이 저장 규칙을 쓴다", () => {
  let id = 0;
  let settings = addIndicator(DEFAULT_CHART_SETTINGS, { kind: "debt_ratio" }, { colors: ["ind-3"], width: 2 }, () => String(++id)).settings;
  settings = updateIndicator(settings, "1", { visible: false });
  settings = movePanel(settings, "2", -1);
  settings = setPanelStretches(settings, [0.61, 0.27]);
  expect(parseChartSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  expect(settings.indicators.at(-1)).toMatchObject({ spec: { kind: "debt_ratio" }, visible: false });
  expect(settings.panels).toEqual([{ id: "2", stretch: 0.61 }, { id: DEFAULT_CHART_SETTINGS.panels[0]!.id, stretch: 0.27 }]);
});

test("실제 종료일의 API bucket과 기간겹침을 보존하고 null과 0을 구분한다", () => {
  const overlap = { ...point, reason: "period_overlap", reportedValue: -123 } satisfies FinancialPoint;
  const buckets = financialBuckets([overlap, point, { ...point, priceBucket: null }]);
  expect([...buckets.keys()]).toEqual([point.priceBucket]);
  expect(buckets.get(kst("2024-01-01"))).toHaveLength(2);
  expect(financialDetail(overlap, "revenue")).toContain("원래 보고값 -123 KRW · 합산하지 않음");
  expect(financialDetail(overlap, "revenue")).toContain("표시값 —");
  expect(financialValue(0, "dps", "KRW")).toBe("0 원/주");
  expect(financialValue(-10, "investing_cash_flow", "USD")).toBe("-10 USD");
});

test("분기·연간 빈 구간은 연결하지 않는다", () => {
  expect(adjacentBucket(kst("2024-01-01"), kst("2024-04-01"), "Q")).toBe(true);
  expect(adjacentBucket(kst("2024-01-01"), kst("2024-07-01"), "Q")).toBe(false);
  expect(adjacentBucket(kst("2023-01-01"), kst("2024-01-01"), "Y")).toBe(true);
  expect(adjacentBucket(kst("2022-01-01"), kst("2024-01-01"), "Y")).toBe(false);
});

test("비교자료와 배당 기간근거의 상태·원금액·시각·실패를 설명한다", () => {
  const input = { businessYear: 2024, reportCode: "11014", usage: "comparison", status: "failed", reason: null, role: "statement", amount: "-1000", period: { kind: "duration", start: "2024-01-01", end: "2024-09-30" }, verificationReason: "receipt_mismatch", basis: "CFS", currency: "KRW", receipt: "20241115000001", disclosedAt: "2024-11-15", contextId: "q", sourceFile: "fact.xbrl", fields: { account_nm: "부채총계" }, checkedAt: 200, lastSuccessAt: 100, failure: "network", refreshVersion: 1 } satisfies FinancialPoint["inputs"][number];
  const detail = financialDetail({ ...point, inputs: [input, { ...input, usage: "reporting_period" }] }, "debt_ratio");
  for (const text of ["비교기간", "조회 실패", "배당 보고기간 근거", "부채총계: -1000 KRW", "자본총계가 0 이하", "2024-01-01 ~ 2024-09-30", "접수번호 20241115000001", "마지막 성공", "갱신 실패", "연결"]) expect(detail).toContain(text);
});

test("마지막 확인과 일부 실패·저장값 갱신 실패를 함께 표시한다", () => {
  const page: FinancialsPage = { symbol: "005930", period: "Q", status: "partial_failure", reason: null, failure: "storage", corpCode: null, fiscalMonth: 12, shareClass: null, shareClassReason: null, lastCheckedAt: 100, lastAttemptAt: 200, disclosureFailure: "network", refreshVersion: 1, disclosureVersion: 1, latestCorrections: true, progress: { total: 10, completed: 8, failed: 1, pending: 1 }, series: [{ metric: "revenue", points: [{ ...point, value: 100 }] }] };
  expect(financialSummary(page)).toContain("일부 조회 실패 · 실패 1건 · 갱신 실패 · 저장 자료 유지 · 마지막 확인");
});
