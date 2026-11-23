import { expect, test } from "vitest";
import type { FinancialUpdatePage } from "../api/generated/FinancialUpdatePage";
import type { FinancialUpdatePhase } from "../api/generated/FinancialUpdatePhase";
import type { FinancialUpdateStatus } from "../api/generated/FinancialUpdateStatus";
import type { FinancialUpdateStopReason } from "../api/generated/FinancialUpdateStopReason";
import { financialButtonView, financialJobAction, financialJobActive, financialJobProgress, financialJobTone, financialJobView, financialTime, type FinancialJobAction, type FinancialJobTone } from "./financialJob";

const titleByStatus: Record<FinancialUpdateStatus, string> = {
  idle: "업데이트 전", planning: "대상 회사 확인 중", collecting: "최근 자료 수집 중", pausing: "일시정지 처리 중", paused: "일시정지됨",
  stopped: "재무자료 수집 정지", checking: "재개 확인 중", ready: "최근 자료 확인 완료 · 과거 이력 미수집", partial_failure: "일부 자료 확인 실패",
  interrupted: "중단된 작업 있음", failed: "업데이트 실패", not_configured: "DART 연동 미설정",
};
const everyStopReason: Record<FinancialUpdateStopReason, true> = { user: true, storage: true, interrupted: true, not_configured: true, authentication: true, rate_limited: true };
const phaseName: Record<FinancialUpdatePhase, string> = { planning: "대상 회사 확인", recent: "최근 자료", changes: "정정·실패 자료", history: "과거 이력", complete: "처리 종료" };
const stopReasons = Object.keys(everyStopReason) as FinancialUpdateStopReason[];

const pageOf = (overrides: Partial<FinancialUpdatePage> = {}): FinancialUpdatePage => ({
  id: 1, status: "idle", phase: "planning", stopReason: null, nextCheckAt: null, canResume: false, automatic: false, latestCheckPending: false,
  historyCompletedCompanies: 0, historyFailedCompanies: 0, recentFailedCompanies: 0, historyComplete: false, fromYear: 2023, throughYear: 2025,
  totalSymbols: 0, processedSymbols: 0, unsupportedSymbols: 0, unverifiedSymbols: 0, unverifiedDividends: 0, totalCompanies: 0, completedCompanies: 0,
  failedCompanies: 0, startedAt: null, lastCheckedAt: null, failure: null, failures: [], ...overrides,
});

test.each(Object.entries(titleByStatus) as [FinancialUpdateStatus, string][])("%s 상태의 기본 제목은 %s", (status, title) => {
  const view = financialJobView(pageOf({ status }), false);
  expect(view.title).toBe(title);
  expect(view.lastCheckedNote).toBe("마지막 확인 아직 없음");
});

test.each(stopReasons)("%s 정지 사유에는 사유와 안내 문구가 있다", (stopReason) => {
  const stopNote = financialJobView(pageOf({ status: "stopped", stopReason }), false).stopNote;
  expect(stopNote).toMatch(/^정지 사유: \S.*\. \S.*$/);
});

test.each(Object.entries(phaseName) as [FinancialUpdatePhase, string][])("%s 단계의 현재 단계 줄은 %s", (phase, name) => {
  const rows = new Map(financialJobView(pageOf({ phase }), false).rows);
  expect(rows.get("현재 단계")).toBe(name);
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

test.each<[string, Partial<FinancialUpdatePage>, boolean, FinancialJobAction]>([
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
  ["도중에 실패한 뒤 재개", { status: "failed", canResume: true, failure: "storage" }, false, { command: "resume", label: "재개", disabled: false }],
  ["도중에 일부 실패하면 재개", { status: "partial_failure", canResume: true, failure: "remote" }, false, { command: "resume", label: "재개", disabled: false }],
  ["도중에 한도로 정지하면 확인 후 재개", { status: "stopped", stopReason: "rate_limited", canResume: true }, false, { command: "resume", label: "확인 후 재개", disabled: false }],
  ["중단된 작업은 이어서 업데이트", { status: "interrupted", stopReason: "interrupted", canResume: true }, false, { command: "resume", label: "이어서 업데이트", disabled: false }],
  ["재개 요청 중", { status: "stopped", stopReason: "authentication", canResume: true }, true, { command: "resume", label: "요청 중", disabled: true }],
  ["미설정이면 비활성 전체 업데이트", { status: "not_configured", stopReason: "not_configured" }, false, { command: "start", label: "전체 업데이트", disabled: true }],
  ["미설정에서 재개 가능해도 비활성", { status: "not_configured", stopReason: "not_configured", canResume: true }, false, { command: "resume", label: "재개", disabled: true }],
])("버튼: %s", (_, overrides, commandPending, action) => {
  expect(financialJobView(pageOf(overrides), commandPending).action).toEqual(action);
});

test.each<[string, boolean, FinancialJobAction]>([
  ["자료가 없으면 비활성 전체 업데이트", false, { command: "start", label: "전체 업데이트", disabled: true }],
  ["자료가 없는데 요청 중이면 비활성 요청 중", true, { command: "start", label: "요청 중", disabled: true }],
])("버튼: %s", (_, commandPending, action) => {
  expect(financialJobAction(undefined, commandPending)).toEqual(action);
});

test("자료가 있으면 버튼은 view의 버튼과 같다", () => {
  const job = pageOf({ status: "stopped", stopReason: "rate_limited", canResume: true });
  expect(financialJobAction(job, false)).toEqual(financialJobView(job, false).action);
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
  ["자동이면 다음 자동 확인", { nextCheckAt, automatic: true, status: "ready" }, `다음 자동 확인 (한국 시각): ${financialTime(nextCheckAt)}`],
  ["수동이면 다음 확인 기준", { nextCheckAt, automatic: false, status: "ready" }, `다음 확인 기준 (한국 시각): ${financialTime(nextCheckAt)}`],
  ["도중에 한도로 정지하면 한도 해제 안내가 붙는다", { nextCheckAt, automatic: true, status: "stopped", stopReason: "rate_limited", canResume: true }, `다음 자동 확인 (한국 시각): ${financialTime(nextCheckAt)}. 요청 하나가 성공하면 이어 받습니다.`],
  ["한도 아닌 정지에는 안내가 붙지 않는다", { nextCheckAt, automatic: false, status: "stopped", stopReason: "authentication" }, `다음 확인 기준 (한국 시각): ${financialTime(nextCheckAt)}`],
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
  expect(view.lastCheckedNote).toBe(`마지막 확인 ${financialTime(nextCheckAt)}`);
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
  ["빈 실패 코드", { status: "failed", failure: "" }, null],
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

test.each<[string, Partial<FinancialUpdatePage>, { done: number; total: number; text: string; percent: number } | null]>([
  ["진행 중이 아니면 없다", { status: "ready", phase: "complete", historyCompletedCompanies: 9, totalCompanies: 9 }, null],
  ["정지면 없다", { status: "stopped", phase: "recent", completedCompanies: 3, totalCompanies: 9 }, null],
  ["대상 확인 중", { status: "planning", phase: "planning", completedCompanies: 0, totalCompanies: 0 }, { done: 0, total: 0, text: "대상 회사 확인 · 0 / 0회사", percent: 0 }],
  ["최근 자료 수집은 최근 완료 수의 절반까지", { status: "collecting", phase: "recent", completedCompanies: 3, historyCompletedCompanies: 1, totalCompanies: 9 }, { done: 3, total: 9, text: "최근 자료 · 3 / 9회사", percent: 50 / 3 }],
  ["정정 수집은 최근 완료 수", { status: "collecting", phase: "changes", completedCompanies: 8, historyCompletedCompanies: 1, totalCompanies: 9 }, { done: 8, total: 9, text: "정정·실패 자료 · 8 / 9회사", percent: 400 / 9 }],
  ["과거 이력 수집은 절반에서 시작해 과거 완료 수만큼 오른다", { status: "collecting", phase: "history", completedCompanies: 9, historyCompletedCompanies: 4, totalCompanies: 9 }, { done: 4, total: 9, text: "과거 이력 · 4 / 9회사", percent: 50 + 200 / 9 }],
  ["처리 종료 단계 정지 중은 과거 이력 완료 수", { status: "pausing", phase: "complete", completedCompanies: 9, historyCompletedCompanies: 7, totalCompanies: 9 }, { done: 7, total: 9, text: "처리 종료 · 7 / 9회사", percent: 50 + 350 / 9 }],
  ["재개 확인 중", { status: "checking", phase: "recent", completedCompanies: 2, totalCompanies: 9 }, { done: 2, total: 9, text: "최근 자료 · 2 / 9회사", percent: 100 / 9 }],
])("진행률: %s", (_, overrides, progress) => {
  const view = financialJobView(pageOf(overrides), false).progress;
  if (progress === null) expect(view).toBeNull();
  else {
    expect(view).toMatchObject({ done: progress.done, total: progress.total, text: progress.text });
    expect(view!.percent).toBeCloseTo(progress.percent, 6);
  }
});

test("최근 자료 단계에서 과거 이력 단계로 넘어갈 때 진행률이 줄지 않는다", () => {
  const steps: Partial<FinancialUpdatePage>[] = [
    { phase: "recent", completedCompanies: 4 }, { phase: "recent", completedCompanies: 9 }, { phase: "changes", completedCompanies: 9 },
    { phase: "history", completedCompanies: 9, historyCompletedCompanies: 0 }, { phase: "history", completedCompanies: 9, historyCompletedCompanies: 5 },
    { phase: "history", completedCompanies: 9, historyCompletedCompanies: 9 },
  ];
  const percents = steps.map((step) => financialJobProgress(pageOf({ status: "collecting", totalCompanies: 9, ...step }))!.percent);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));
  expect(percents[2]).toBe(50);
  expect(percents[3]).toBe(50);
  expect(percents.at(-1)).toBe(100);
});

test("진행 막대는 최근·과거 두 칸의 채움 비율을 준다", () => {
  const stages = financialJobProgress(pageOf({ status: "collecting", phase: "history", totalCompanies: 10, completedCompanies: 10, historyCompletedCompanies: 4 }))!.stages;
  expect(stages).toEqual([{ name: "최근", fill: 1 }, { name: "과거", fill: 0.4 }]);
  expect(financialJobProgress(pageOf({ status: "collecting", phase: "recent", totalCompanies: 10, completedCompanies: 3 }))!.stages).toEqual([{ name: "최근", fill: 0.3 }, { name: "과거", fill: 0 }]);
});

test("아직 불러오지 못한 상태는 쉼이다", () => {
  expect(financialJobTone(undefined)).toBe("idle");
});

test.each<[string, Partial<FinancialUpdatePage>, FinancialJobTone]>([
  ["대상 확인", { status: "planning" }, "active"], ["수집 중", { status: "collecting" }, "active"], ["정지 처리 중", { status: "pausing", stopReason: "user" }, "active"], ["재개 확인 중", { status: "checking", stopReason: "rate_limited" }, "active"],
  ["수집한 적 없음", { status: "idle" }, "idle"], ["DART 미설정", { status: "not_configured", stopReason: "not_configured" }, "idle"],
  ["일시정지", { status: "paused", stopReason: "user" }, "paused"], ["중단", { status: "interrupted", stopReason: "interrupted" }, "paused"],
  ["사용자 정지", { status: "stopped", stopReason: "user" }, "paused"], ["서버 중단 정지", { status: "stopped", stopReason: "interrupted" }, "paused"], ["사유 없는 정지", { status: "stopped" }, "paused"],
  ["인증 정지", { status: "stopped", stopReason: "authentication" }, "attention"], ["한도 정지", { status: "stopped", stopReason: "rate_limited" }, "attention"], ["저장 실패 정지", { status: "stopped", stopReason: "storage" }, "attention"],
  ["일부 실패", { status: "partial_failure" }, "attention"], ["실패", { status: "failed", failure: "network" }, "attention"],
  ["완료", { status: "ready" }, "done"],
])("점 종류: %s는 %s", (_, overrides, tone) => {
  expect(financialJobTone(pageOf(overrides))).toBe(tone);
  expect(financialJobView(pageOf(overrides), false).statusTone).toBe(tone);
});

test("인증 정지와 일시정지의 표시 종류가 다르다", () => {
  const authentication = financialButtonView(pageOf({ status: "stopped", stopReason: "authentication", canResume: true }));
  const paused = financialButtonView(pageOf({ status: "paused", stopReason: "user", canResume: true }));
  expect(authentication.tone).not.toBe(paused.tone);
  expect(authentication.text).toBe("확인 필요");
  expect(paused.text).toBe("멈춤");
});

test.each<[string, Partial<FinancialUpdatePage> | undefined, { dot: boolean; text: string | null }]>([
  ["자료를 못 불러왔으면 점도 글자도 없다", undefined, { dot: false, text: null }],
  ["수집한 적이 없으면 점도 글자도 없다", { status: "idle" }, { dot: false, text: null }],
  ["DART를 쓰지 않아도 경고 점이 없다", { status: "not_configured", stopReason: "not_configured" }, { dot: false, text: null }],
  ["수집 중이면 점과 전체 기준 진행률", { status: "collecting", phase: "history", totalCompanies: 10, completedCompanies: 10, historyCompletedCompanies: 5 }, { dot: true, text: "75%" }],
  ["대상 확인 중이면 회사 수가 없어 진행률 글자가 없다", { status: "planning" }, { dot: true, text: null }],
  ["완료면 점이 없다", { status: "ready" }, { dot: false, text: null }],
])("버튼 표시: %s", (_, overrides, expected) => {
  expect(financialButtonView(overrides && pageOf(overrides))).toMatchObject(expected);
});

test.each<[FinancialUpdateStopReason, { problem: string; opensSettings: boolean }]>([
  ["authentication", { problem: "DART 인증키를 확인해야 합니다", opensSettings: true }],
  ["rate_limited", { problem: "DART 호출 한도에 걸렸습니다", opensSettings: false }],
  ["user", { problem: "사용자가 일시정지했습니다", opensSettings: false }],
])("%s 정지는 문제 한 줄과 할 일 한 줄만 준다", (stopReason, expected) => {
  const stop = financialJobView(pageOf({ status: "stopped", stopReason }), false).stop;
  expect(stop).toMatchObject(expected);
  expect(stop!.action).not.toBe("");
});

test("진행 중이거나 정지 사유가 없으면 정지 안내가 없다", () => {
  expect(financialJobView(pageOf({ status: "pausing", stopReason: "user" }), false).stop).toBeNull();
  expect(financialJobView(pageOf({ status: "collecting" }), false).stop).toBeNull();
});

test("시각은 한국 시각 YYYY-MM-DD HH:MM이고 수에는 천 단위 쉼표가 붙는다", () => {
  expect(financialTime(Date.parse("2016-01-02T07:05:59+09:00") / 1000)).toBe("2016-01-02 07:05");
  expect(financialTime(Date.parse("2026-11-09T00:00:00+09:00") / 1000)).toBe("2026-11-09 00:00");
  expect(financialTime(null)).toBe("아직 없음");
  const view = financialJobView(pageOf({ status: "ready", historyComplete: true, totalCompanies: 2412, completedCompanies: 2409, lastCheckedAt: Date.parse("2026-11-10T07:00:00+09:00") / 1000 }), false);
  expect(view.completionNote).toBe("마지막 확인 2026-11-10 07:00 · 2,412개 회사");
  expect(new Map(view.rows).get("최근 자료 완료")).toBe("2,409 / 2,412회사");
  expect(financialJobView(pageOf({ status: "collecting" }), false).completionNote).toBeNull();
});

test.each<[string, Partial<FinancialUpdatePage>, string | null]>([
  ["실패 회사가 없으면 없다", { status: "ready", failedCompanies: 0 }, null],
  ["도중에 실패한 회사가 있으면 경고", { status: "collecting", failedCompanies: 3 }, "회사 3곳을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다."],
  ["끝난 뒤 실패한 회사가 있어도 경고", { status: "partial_failure", failedCompanies: 1 }, "회사 1곳을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다."],
])("실패 회사 경고: %s", (_, overrides, failedCompaniesNote) => {
  expect(financialJobView(pageOf(overrides), false).failedCompaniesNote).toBe(failedCompaniesNote);
});
