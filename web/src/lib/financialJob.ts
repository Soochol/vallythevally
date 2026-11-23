import type { FinancialUpdatePage } from "../api/generated/FinancialUpdatePage";
import type { FinancialUpdatePhase } from "../api/generated/FinancialUpdatePhase";
import type { FinancialUpdateStatus } from "../api/generated/FinancialUpdateStatus";
import type { FinancialUpdateStopReason } from "../api/generated/FinancialUpdateStopReason";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { financialFailure } from "../chart/financials";

const KOREA_MINUTE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function financialTime(seconds: UnixSeconds | null): string {
  if (seconds === null) return "아직 없음";
  const parts = Object.fromEntries(KOREA_MINUTE.formatToParts(new Date(seconds * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const count = (value: number) => value.toLocaleString("ko-KR");

const STATUS: Record<FinancialUpdateStatus, string> = {
  idle: "업데이트 전", planning: "대상 회사 확인 중", collecting: "최근 자료 수집 중", pausing: "일시정지 처리 중", paused: "일시정지됨",
  stopped: "재무자료 수집 정지", checking: "재개 확인 중", ready: "업데이트 완료", partial_failure: "일부 자료 확인 실패", interrupted: "중단된 작업 있음", failed: "업데이트 실패", not_configured: "DART 연동 미설정",
};
const PHASE: Record<FinancialUpdatePhase, string> = { planning: "대상 회사 확인", recent: "최근 자료", changes: "정정·실패 자료", history: "과거 이력", complete: "처리 종료" };
const STOP: Record<FinancialUpdateStopReason, string> = { user: "사용자 요청", storage: "자료 저장 실패", interrupted: "서버 중단", not_configured: "DART 설정 필요", authentication: "인증 오류", rate_limited: "호출 한도" };

const STOP_ADVICE: Record<FinancialUpdateStopReason, { problem: string; action: string }> = {
  user: { problem: "사용자가 일시정지했습니다", action: "재개하면 저장된 지점부터 이어 받습니다." },
  storage: { problem: "자료를 저장하지 못했습니다", action: "저장 공간과 권한을 확인한 뒤 재개하세요." },
  interrupted: { problem: "서버가 중단돼 수집이 멈췄습니다", action: "재개하면 저장된 지점부터 이어 받습니다." },
  not_configured: { problem: "DART 연동이 설정되지 않았습니다", action: "서버의 OPENDART_API_KEY를 설정한 뒤 서버를 다시 시작하세요." },
  authentication: { problem: "DART 인증키를 확인해야 합니다", action: "키를 고친 뒤 확인 후 재개를 누르세요. 키를 바꿨다면 서버를 다시 시작하세요." },
  rate_limited: { problem: "DART 호출 한도에 걸렸습니다", action: "재개를 누르면 요청 하나로 한도 해제 여부를 확인합니다." },
};

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

export interface FinancialJobStage {
  name: string;
  fill: number;
}

export interface FinancialJobProgress {
  done: number;
  total: number;
  text: string;
  percent: number;
  stages: [recent: FinancialJobStage, history: FinancialJobStage];
}

export type FinancialJobTone = "idle" | "active" | "paused" | "attention" | "done";

export interface FinancialStopAdvice {
  problem: string;
  action: string;
  opensSettings: boolean;
}

export interface FinancialButtonView {
  tone: FinancialJobTone;
  dot: boolean;
  text: string | null;
}

export interface FinancialJobView {
  title: string;
  statusTone: FinancialJobTone;
  progress: FinancialJobProgress | null;
  stopNote: string | null;
  stop: FinancialStopAdvice | null;
  completionNote: string | null;
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

const NEEDS_ATTENTION_STOPS: readonly FinancialUpdateStopReason[] = ["authentication", "rate_limited", "storage", "not_configured"];

type ToneInput = Pick<FinancialUpdatePage, "status" | "stopReason">;

export function financialJobTone(job: ToneInput | undefined): FinancialJobTone {
  if (job === undefined) return "idle";
  const { status, stopReason } = job;
  if (financialJobActive(status)) return "active";
  if (status === "ready") return "done";
  if (status === "partial_failure" || status === "failed") return "attention";
  if (status === "stopped") return stopReason !== null && NEEDS_ATTENTION_STOPS.includes(stopReason) ? "attention" : "paused";
  if (status === "paused" || status === "interrupted") return "paused";
  return "idle";
}

const share = (done: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, done / total)) : 0);

export function financialJobProgress(job: FinancialUpdatePage): FinancialJobProgress | null {
  if (!financialJobActive(job.status)) return null;
  const inHistory = job.phase === "history" || job.phase === "complete";
  const done = inHistory ? job.historyCompletedCompanies : job.completedCompanies;
  const recent = inHistory ? 1 : share(job.completedCompanies, job.totalCompanies);
  const history = inHistory ? share(job.historyCompletedCompanies, job.totalCompanies) : 0;
  return {
    done,
    total: job.totalCompanies,
    text: `${PHASE[job.phase]} · ${count(done)} / ${count(job.totalCompanies)}회사`,
    percent: (recent + history) * 50,
    stages: [{ name: "최근", fill: recent }, { name: "과거", fill: history }],
  };
}

export function financialButtonView(job: FinancialUpdatePage | undefined): FinancialButtonView {
  const tone = financialJobTone(job);
  if (tone === "active") {
    const progress = job && financialJobProgress(job);
    return { tone, dot: true, text: progress && progress.total > 0 ? `${Math.floor(progress.percent)}%` : null };
  }
  if (tone === "paused") return { tone, dot: true, text: "멈춤" };
  if (tone === "attention") return { tone, dot: true, text: "확인 필요" };
  return { tone, dot: false, text: null };
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
    statusTone: financialJobTone(job),
    progress: financialJobProgress(job),
    stop: job.stopReason && !financialJobActive(job.status) ? { ...STOP_ADVICE[job.stopReason], opensSettings: job.stopReason === "authentication" } : null,
    completionNote: job.status === "ready" ? `마지막 확인 ${financialTime(job.lastCheckedAt)} · ${count(job.totalCompanies)}개 회사` : null,
    stopNote: job.stopReason ? `정지 사유: ${STOP[job.stopReason]}. ${job.status === "pausing" ? "진행 중인 응답을 저장한 뒤 멈춥니다." : STOP_MESSAGE[job.stopReason]}` : null,
    nextCheckNote: job.nextCheckAt === null ? null : `${job.automatic ? "다음 자동 확인" : "다음 확인 기준"} (한국 시각): ${financialTime(job.nextCheckAt)}${job.stopReason === "rate_limited" ? ". 요청 하나가 성공하면 이어 받습니다." : ""}`,
    latestCheckNote: job.latestCheckPending ? "진행 중인 응답을 저장한 뒤 최신 공시와 영향 자료부터 확인합니다." : null,
    failedCompaniesNote: job.failedCompanies > 0 ? `회사 ${count(job.failedCompanies)}곳을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.` : null,
    yearsNote: `최근 ${job.fromYear}~${job.throughYear} 사업연도 · 계산에 필요한 비교기간 포함`,
    rows: [
      ["현재 단계", PHASE[job.phase]],
      ["대상 종목 확인", `${count(job.processedSymbols)} / ${count(job.totalSymbols)}종목`],
      ["최근 자료 완료", `${count(job.completedCompanies)} / ${count(job.totalCompanies)}회사`],
      ["과거 이력 완료", `${count(job.historyCompletedCompanies)} / ${count(job.totalCompanies)}회사`],
      ["전체 이력 확인", job.historyComplete ? "완료" : "미완료"],
      ["실패 회사", `${count(job.failedCompanies)}회사`],
      ["미지원 상품", `${count(job.unsupportedSymbols)}종목`],
      ["공식 회사 연결 미확인", `${count(job.unverifiedSymbols)}종목`],
      ["배당 주식 종류 미확인", `${count(job.unverifiedDividends)}종목`],
    ],
    phaseFailureNote: job.recentFailedCompanies > 0 || job.historyFailedCompanies > 0 ? `최근 단계 실패 ${job.recentFailedCompanies}회사 · 과거 단계 실패 ${job.historyFailedCompanies}회사` : null,
    lastCheckedNote: `마지막 확인 ${financialTime(job.lastCheckedAt)}`,
    notice: NOTICE[job.status] ?? null,
    failureNote: job.failure ? `${financialFailure(job.failure)} · 저장된 완료 지점을 유지합니다.` : null,
    action: financialJobAction(job, commandPending),
  };
}
