import { expect, test } from "vitest";
import type { FinancialUpdatePage } from "../api/generated/FinancialUpdatePage";
import type { FinancialUpdatePhase } from "../api/generated/FinancialUpdatePhase";
import type { FinancialUpdateStatus } from "../api/generated/FinancialUpdateStatus";
import type { FinancialUpdateStopReason } from "../api/generated/FinancialUpdateStopReason";
import { checkedTime } from "../chart/financials";
import { financialJobActive, financialJobView } from "./financialJob";

const everyStatus: Record<FinancialUpdateStatus, true> = {
  idle: true, planning: true, collecting: true, pausing: true, paused: true, stopped: true,
  checking: true, ready: true, partial_failure: true, interrupted: true, failed: true, not_configured: true,
};
const everyStopReason: Record<FinancialUpdateStopReason, true> = { user: true, storage: true, interrupted: true, not_configured: true, authentication: true, rate_limited: true };
const everyPhase: Record<FinancialUpdatePhase, true> = { planning: true, recent: true, changes: true, history: true, complete: true };
const statuses = Object.keys(everyStatus) as FinancialUpdateStatus[];
const stopReasons = Object.keys(everyStopReason) as FinancialUpdateStopReason[];
const phases = Object.keys(everyPhase) as FinancialUpdatePhase[];

const pageOf = (overrides: Partial<FinancialUpdatePage> = {}): FinancialUpdatePage => ({
  id: 1, status: "idle", phase: "planning", stopReason: null, nextCheckAt: null, canResume: false, automatic: false, latestCheckPending: false,
  historyCompletedCompanies: 0, historyFailedCompanies: 0, recentFailedCompanies: 0, historyComplete: false, fromYear: 2023, throughYear: 2025,
  totalSymbols: 0, processedSymbols: 0, unsupportedSymbols: 0, unverifiedSymbols: 0, unverifiedDividends: 0, totalCompanies: 0, completedCompanies: 0,
  failedCompanies: 0, startedAt: null, lastCheckedAt: null, failure: null, failures: [], ...overrides,
});

test.each(statuses)("%s 상태에도 제목과 마지막 확인 문구가 있다", (status) => {
  const view = financialJobView(pageOf({ status }), false);
  expect(view.title).not.toBe("");
  expect(view.lastCheckedNote).toBe("마지막 확인 아직 없음");
});

test.each(stopReasons)("%s 정지 사유에는 사유와 안내 문구가 있다", (stopReason) => {
  const stopNote = financialJobView(pageOf({ status: "stopped", stopReason }), false).stopNote;
  expect(stopNote).toMatch(/^정지 사유: \S.*\. \S.*$/);
});

test.each(phases)("%s 단계에도 현재 단계 줄에 이름이 있다", (phase) => {
  const rows = new Map(financialJobView(pageOf({ phase }), false).rows);
  expect(rows.get("현재 단계")).toMatch(/\S/);
});

test.each<[string, Partial<FinancialUpdatePage>, string]>([
  ["최신 공시 확인이 다른 모든 제목보다 먼저다", { latestCheckPending: true, status: "ready", historyComplete: true }, "최신 공시 확인 대기"],
  ["최신 공시 확인은 수집 중 이력 단계보다 먼저다", { latestCheckPending: true, status: "collecting", phase: "history" }, "최신 공시 확인 대기"],
  ["완료와 전체 이력", { status: "ready", historyComplete: true }, "전체 이력 확인 완료"],
  ["완료지만 과거 이력 미수집", { status: "ready", historyComplete: false }, "최근 자료 확인 완료 · 과거 이력 미수집"],
  ["수집 중 과거 이력 단계", { status: "collecting", phase: "history" }, "과거 이력 수집 중"],
  ["수집 중 정정 단계", { status: "collecting", phase: "changes" }, "정정·실패 자료 수집 중"],
  ["수집 중 최근 단계", { status: "collecting", phase: "recent" }, "최근 자료 수집 중"],
  ["이력 단계여도 수집 중이 아니면 상태 이름", { status: "paused", phase: "history" }, "일시정지됨"],
  ["정지", { status: "stopped", stopReason: "rate_limited" }, "재무자료 수집 정지"],
  ["처음부터 실패", { status: "failed", failure: "authentication" }, "업데이트 실패"],
  ["미설정", { status: "not_configured" }, "DART 연동 미설정"],
])("제목: %s", (_, overrides, title) => {
  expect(financialJobView(pageOf(overrides), false).title).toBe(title);
});

test.each<[string, Partial<FinancialUpdatePage>, boolean, { command: "start" | "pause" | "resume"; label: string; disabled: boolean }]>([
  ["수집 중이면 일시정지", { status: "collecting" }, false, { command: "pause", label: "일시정지", disabled: false }],
  ["대상 확인 중이면 일시정지", { status: "planning" }, false, { command: "pause", label: "일시정지", disabled: false }],
  ["일시정지 요청 중이면 비활성 일시정지", { status: "collecting" }, true, { command: "pause", label: "일시정지", disabled: true }],
  ["정지 처리 중", { status: "pausing", stopReason: "user" }, false, { command: "pause", label: "정지 중", disabled: true }],
  ["재개 확인 중", { status: "checking", stopReason: "rate_limited" }, false, { command: "pause", label: "확인 중", disabled: true }],
  ["처음 업데이트", { status: "idle" }, false, { command: "start", label: "전체 업데이트", disabled: false }],
  ["완료 뒤 다시 업데이트", { status: "ready", historyComplete: true }, false, { command: "start", label: "전체 업데이트", disabled: false }],
  ["처음부터 실패하면 다시 전체 업데이트", { status: "failed", failure: "network" }, false, { command: "start", label: "전체 업데이트", disabled: false }],
  ["시작 요청 중", { status: "idle" }, true, { command: "start", label: "요청 중", disabled: true }],
  ["일시정지에서 재개", { status: "paused", stopReason: "user", canResume: true }, false, { command: "resume", label: "재개", disabled: false }],
  ["도중에 일부 실패하면 재개", { status: "partial_failure", canResume: true, failure: "remote" }, false, { command: "resume", label: "재개", disabled: false }],
  ["도중에 한도로 정지하면 확인 후 재개", { status: "stopped", stopReason: "rate_limited", canResume: true }, false, { command: "resume", label: "확인 후 재개", disabled: false }],
  ["중단된 작업은 이어서 업데이트", { status: "interrupted", stopReason: "interrupted", canResume: true }, false, { command: "resume", label: "이어서 업데이트", disabled: false }],
  ["재개 요청 중", { status: "stopped", stopReason: "authentication", canResume: true }, true, { command: "resume", label: "요청 중", disabled: true }],
  ["미설정이면 비활성 전체 업데이트", { status: "not_configured", stopReason: "not_configured" }, false, { command: "start", label: "전체 업데이트", disabled: true }],
  ["미설정에서 재개 가능해도 비활성", { status: "not_configured", stopReason: "not_configured", canResume: true }, false, { command: "resume", label: "재개", disabled: true }],
])("버튼: %s", (_, overrides, commandPending, action) => {
  expect(financialJobView(pageOf(overrides), commandPending).action).toEqual(action);
});

test("정지 처리 중에는 사유 뒤에 저장 후 멈춘다는 문구가 붙는다", () => {
  expect(financialJobView(pageOf({ status: "pausing", stopReason: "user" }), false).stopNote).toBe("정지 사유: 사용자 요청. 진행 중인 응답을 저장한 뒤 멈춥니다.");
});

test.each<[FinancialUpdateStopReason, string]>([
  ["user", "정지 사유: 사용자 요청. 재개하면 저장된 지점부터 이어 받습니다."],
  ["storage", "정지 사유: 자료 저장 실패. 저장 공간과 권한을 확인한 뒤 재개하세요."],
  ["interrupted", "정지 사유: 서버 중단. 재개하면 저장된 지점부터 이어 받습니다."],
  ["not_configured", "정지 사유: DART 설정 필요. 서버의 OPENDART_API_KEY를 설정한 뒤 서버를 다시 시작하세요."],
  ["authentication", "정지 사유: 인증 오류. 서버의 DART 인증 설정을 수정한 뒤 재개하세요. 키를 바꿨다면 서버를 다시 시작하세요. 확인 요청이 성공해야 이어 받습니다."],
  ["rate_limited", "정지 사유: 호출 한도. 재개를 누르면 요청 하나로 한도 해제 여부를 확인합니다. 확인에 실패하면 계속 대기합니다."],
])("%s 정지 문구", (stopReason, stopNote) => {
  expect(financialJobView(pageOf({ status: "stopped", stopReason }), false).stopNote).toBe(stopNote);
});

test("정지 사유가 없으면 정지 문구가 없다", () => {
  expect(financialJobView(pageOf({ status: "collecting" }), false).stopNote).toBeNull();
});

const nextCheckAt = 1_794_000_000;
test.each<[string, Partial<FinancialUpdatePage>, string | null]>([
  ["다음 확인 시각이 없으면 없다", { nextCheckAt: null, automatic: true }, null],
  ["자동이면 다음 자동 확인", { nextCheckAt, automatic: true, status: "ready" }, `다음 자동 확인 (한국 시각): ${checkedTime(nextCheckAt)}`],
  ["수동이면 다음 확인 기준", { nextCheckAt, automatic: false, status: "ready" }, `다음 확인 기준 (한국 시각): ${checkedTime(nextCheckAt)}`],
  ["도중에 한도로 정지하면 한도 해제 안내가 붙는다", { nextCheckAt, automatic: true, status: "stopped", stopReason: "rate_limited", canResume: true }, `다음 자동 확인 (한국 시각): ${checkedTime(nextCheckAt)}. 요청 하나가 성공하면 이어 받습니다.`],
  ["한도 아닌 정지에는 안내가 붙지 않는다", { nextCheckAt, automatic: false, status: "stopped", stopReason: "authentication" }, `다음 확인 기준 (한국 시각): ${checkedTime(nextCheckAt)}`],
])("다음 확인: %s", (_, overrides, nextCheckNote) => {
  expect(financialJobView(pageOf(overrides), false).nextCheckNote).toBe(nextCheckNote);
});

test("최신 공시 확인 대기일 때만 확인 안내가 있다", () => {
  expect(financialJobView(pageOf({ latestCheckPending: true, status: "collecting" }), false).latestCheckNote).toBe("진행 중인 응답을 저장한 뒤 최신 공시와 영향 자료부터 확인합니다.");
  expect(financialJobView(pageOf({ status: "collecting" }), false).latestCheckNote).toBeNull();
});

test("사업연도 줄과 현황 표는 페이지의 수를 그대로 적는다", () => {
  const view = financialJobView(pageOf({
    status: "collecting", phase: "history", fromYear: 2022, throughYear: 2025, processedSymbols: 10, totalSymbols: 20, completedCompanies: 7, totalCompanies: 9,
    historyCompletedCompanies: 3, historyComplete: false, failedCompanies: 2, unsupportedSymbols: 4, unverifiedSymbols: 5, unverifiedDividends: 6, lastCheckedAt: nextCheckAt,
  }), false);
  expect(view.yearsNote).toBe("최근 2022~2025 사업연도 · 계산에 필요한 비교기간 포함");
  expect(view.rows).toEqual([
    ["현재 단계", "과거 이력"],
    ["대상 종목 확인", "10 / 20종목"],
    ["최근 자료 완료", "7 / 9회사"],
    ["과거 이력 완료", "3 / 9회사"],
    ["전체 이력 확인", "미완료"],
    ["실패 회사", "2회사"],
    ["미지원 상품", "4종목"],
    ["공식 회사 연결 미확인", "5종목"],
    ["배당 주식 종류 미확인", "6종목"],
  ]);
  expect(view.lastCheckedNote).toBe(`마지막 확인 ${checkedTime(nextCheckAt)}`);
  expect(new Map(financialJobView(pageOf({ historyComplete: true }), false).rows).get("전체 이력 확인")).toBe("완료");
});

test.each<[string, Partial<FinancialUpdatePage>, string | null]>([
  ["실패가 없으면 없다", {}, null],
  ["최근 단계만 실패", { recentFailedCompanies: 2 }, "최근 단계 실패 2회사 · 과거 단계 실패 0회사"],
  ["과거 단계만 실패", { historyFailedCompanies: 3 }, "최근 단계 실패 0회사 · 과거 단계 실패 3회사"],
])("단계별 실패 줄: %s", (_, overrides, phaseFailureNote) => {
  expect(financialJobView(pageOf(overrides), false).phaseFailureNote).toBe(phaseFailureNote);
});

test.each<[FinancialUpdateStatus, string | null]>([
  ["not_configured", "서버의 OPENDART_API_KEY를 설정하면 업데이트할 수 있습니다. 저장된 자료는 계속 조회할 수 있습니다."],
  ["partial_failure", "일부 자료를 확인하지 못해 전체 이력 확인이 미완료입니다. 저장된 자료는 계속 사용할 수 있습니다."],
  ["ready", null],
  ["failed", null],
])("%s 상태 안내", (status, notice) => {
  expect(financialJobView(pageOf({ status }), false).notice).toBe(notice);
});

test.each<[string, Partial<FinancialUpdatePage>, string | null]>([
  ["실패가 없으면 없다", { status: "collecting" }, null],
  ["처음부터 인증 실패", { status: "failed", failure: "authentication" }, "DART 인증 설정 확인 필요 · 저장된 완료 지점을 유지합니다."],
  ["도중에 한도로 정지", { status: "stopped", stopReason: "rate_limited", canResume: true, failure: "rate_limited" }, "자료원 조회 한도 초과 · 저장된 완료 지점을 유지합니다."],
  ["모르는 실패 코드", { status: "failed", failure: "mystery" }, "자료 조회 실패 · 저장된 완료 지점을 유지합니다."],
])("실패 문구: %s", (_, overrides, failureNote) => {
  expect(financialJobView(pageOf(overrides), false).failureNote).toBe(failureNote);
});

test.each<[FinancialUpdateStatus | undefined, boolean]>([
  ["planning", true], ["collecting", true], ["pausing", true], ["checking", true],
  ["idle", false], ["paused", false], ["stopped", false], ["ready", false], ["partial_failure", false], ["interrupted", false], ["failed", false], ["not_configured", false],
  [undefined, false],
])("%s 상태의 진행 여부는 %s", (status, active) => {
  expect(financialJobActive(status)).toBe(active);
});
