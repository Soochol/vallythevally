import type { FinancialUpdatePage } from "../api/generated/FinancialUpdatePage";
import type { FinancialUpdatePhase } from "../api/generated/FinancialUpdatePhase";
import type { FinancialUpdateStatus } from "../api/generated/FinancialUpdateStatus";
import type { FinancialUpdateStopReason } from "../api/generated/FinancialUpdateStopReason";
import { checkedTime, financialFailure } from "../chart/financials";

const STATUS: Record<FinancialUpdateStatus, string> = {
  idle: "업데이트 전", planning: "대상 회사 확인 중", collecting: "최근 자료 수집 중", pausing: "일시정지 처리 중", paused: "일시정지됨",
  stopped: "재무자료 수집 정지", checking: "재개 확인 중", ready: "업데이트 완료", partial_failure: "일부 자료 확인 실패", interrupted: "중단된 작업 있음", failed: "업데이트 실패", not_configured: "DART 연동 미설정",
};
const PHASE: Record<FinancialUpdatePhase, string> = { planning: "대상 회사 확인", recent: "최근 자료", changes: "정정·실패 자료", history: "과거 이력", complete: "처리 종료" };
const STOP: Record<FinancialUpdateStopReason, string> = { user: "사용자 요청", storage: "자료 저장 실패", interrupted: "서버 중단", not_configured: "DART 설정 필요", authentication: "인증 오류", rate_limited: "호출 한도" };

const STOP_MESSAGE: Record<FinancialUpdateStopReason, string> = {
  user: "재개하면 저장된 지점부터 이어 받습니다.", storage: "저장 공간과 권한을 확인한 뒤 재개하세요.", interrupted: "재개하면 저장된 지점부터 이어 받습니다.",
  not_configured: "서버의 OPENDART_API_KEY를 설정한 뒤 서버를 다시 시작하세요.",
  authentication: "서버의 DART 인증 설정을 수정한 뒤 재개하세요. 키를 바꿨다면 서버를 다시 시작하세요. 확인 요청이 성공해야 이어 받습니다.",
  rate_limited: "재개를 누르면 요청 하나로 한도 해제 여부를 확인합니다. 확인에 실패하면 계속 대기합니다.",
};

const NOTICE: Partial<Record<FinancialUpdateStatus, string>> = {
  not_configured: "서버의 OPENDART_API_KEY를 설정하면 업데이트할 수 있습니다. 저장된 자료는 계속 조회할 수 있습니다.",
  partial_failure: "일부 자료를 확인하지 못해 전체 이력 확인이 미완료입니다. 저장된 자료는 계속 사용할 수 있습니다.",
};

export type FinancialJobCommand = "start" | "pause" | "resume";

export interface FinancialJobAction {
  command: FinancialJobCommand;
  label: string;
  disabled: boolean;
}

export interface FinancialJobProgress {
  done: number;
  total: number;
  text: string;
}

export type FinancialJobTone = "active" | "success" | "idle" | "warning";

export interface FinancialJobView {
  title: string;
  statusTone: FinancialJobTone;
  progress: FinancialJobProgress | null;
  stopNote: string | null;
  nextCheckNote: string | null;
  latestCheckNote: string | null;
  failedCompaniesNote: string | null;
  yearsNote: string;
  rows: [name: string, value: string][];
  phaseFailureNote: string | null;
  lastCheckedNote: string;
  notice: string | null;
  failureNote: string | null;
  action: FinancialJobAction;
}

export const financialJobActive = (status: FinancialUpdateStatus | undefined) => status === "planning" || status === "collecting" || status === "pausing" || status === "checking";

function titleOf(job: FinancialUpdatePage): string {
  if (job.latestCheckPending) return "최신 공시 확인 대기";
  if (job.status === "ready") return job.historyComplete ? "전체 이력 확인 완료" : "최근 자료 확인 완료 · 과거 이력 미수집";
  if (job.status === "collecting" && job.phase === "history") return "과거 이력 수집 중";
  if (job.status === "collecting" && job.phase === "changes") return "정정·실패 자료 수집 중";
  return STATUS[job.status];
}

export function financialJobTone(status: FinancialUpdateStatus | undefined): FinancialJobTone {
  if (status === undefined || status === "idle") return "idle";
  if (financialJobActive(status)) return "active";
  return status === "ready" ? "success" : "warning";
}

export function financialJobProgress(job: FinancialUpdatePage): FinancialJobProgress | null {
  if (!financialJobActive(job.status)) return null;
  const done = job.phase === "history" || job.phase === "complete" ? job.historyCompletedCompanies : job.completedCompanies;
  return { done, total: job.totalCompanies, text: `${PHASE[job.phase]} · ${done} / ${job.totalCompanies}회사` };
}

function resumeLabel(status: FinancialUpdateStatus): string {
  if (status === "stopped") return "확인 후 재개";
  if (status === "interrupted") return "이어서 업데이트";
  return "재개";
}

export function financialJobAction(job: FinancialUpdatePage | undefined, commandPending: boolean): FinancialJobAction {
  if (!job) return { command: "start", label: commandPending ? "요청 중" : "전체 업데이트", disabled: true };
  if (financialJobActive(job.status)) {
    return {
      command: "pause",
      label: job.status === "checking" ? "확인 중" : job.status === "pausing" ? "정지 중" : "일시정지",
      disabled: commandPending || job.status === "pausing" || job.status === "checking",
    };
  }
  return {
    command: job.canResume ? "resume" : "start",
    label: commandPending ? "요청 중" : job.canResume ? resumeLabel(job.status) : "전체 업데이트",
    disabled: job.status === "not_configured" || commandPending,
  };
}

export function financialJobView(job: FinancialUpdatePage, commandPending: boolean): FinancialJobView {
  return {
    title: titleOf(job),
    statusTone: financialJobTone(job.status),
    progress: financialJobProgress(job),
    stopNote: job.stopReason ? `정지 사유: ${STOP[job.stopReason]}. ${job.status === "pausing" ? "진행 중인 응답을 저장한 뒤 멈춥니다." : STOP_MESSAGE[job.stopReason]}` : null,
    nextCheckNote: job.nextCheckAt === null ? null : `${job.automatic ? "다음 자동 확인" : "다음 확인 기준"} (한국 시각): ${checkedTime(job.nextCheckAt)}${job.stopReason === "rate_limited" ? ". 요청 하나가 성공하면 이어 받습니다." : ""}`,
    latestCheckNote: job.latestCheckPending ? "진행 중인 응답을 저장한 뒤 최신 공시와 영향 자료부터 확인합니다." : null,
    failedCompaniesNote: job.failedCompanies > 0 ? `회사 ${job.failedCompanies}곳을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.` : null,
    yearsNote: `최근 ${job.fromYear}~${job.throughYear} 사업연도 · 계산에 필요한 비교기간 포함`,
    rows: [
      ["현재 단계", PHASE[job.phase]],
      ["대상 종목 확인", `${job.processedSymbols} / ${job.totalSymbols}종목`],
      ["최근 자료 완료", `${job.completedCompanies} / ${job.totalCompanies}회사`],
      ["과거 이력 완료", `${job.historyCompletedCompanies} / ${job.totalCompanies}회사`],
      ["전체 이력 확인", job.historyComplete ? "완료" : "미완료"],
      ["실패 회사", `${job.failedCompanies}회사`],
      ["미지원 상품", `${job.unsupportedSymbols}종목`],
      ["공식 회사 연결 미확인", `${job.unverifiedSymbols}종목`],
      ["배당 주식 종류 미확인", `${job.unverifiedDividends}종목`],
    ],
    phaseFailureNote: job.recentFailedCompanies > 0 || job.historyFailedCompanies > 0 ? `최근 단계 실패 ${job.recentFailedCompanies}회사 · 과거 단계 실패 ${job.historyFailedCompanies}회사` : null,
    lastCheckedNote: `마지막 확인 ${checkedTime(job.lastCheckedAt)}`,
    notice: NOTICE[job.status] ?? null,
    failureNote: job.failure ? `${financialFailure(job.failure)} · 저장된 완료 지점을 유지합니다.` : null,
    action: financialJobAction(job, commandPending),
  };
}
