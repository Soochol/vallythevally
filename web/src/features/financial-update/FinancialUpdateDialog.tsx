import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FinancialUpdateStatus } from "../../api/generated/FinancialUpdateStatus";
import type { FinancialUpdatePhase } from "../../api/generated/FinancialUpdatePhase";
import type { FinancialUpdateStopReason } from "../../api/generated/FinancialUpdateStopReason";
import { commandFinancialUpdate, updateActive, useFinancialUpdate } from "../../api/financialUpdate";
import { checkedTime, financialFailure } from "../../chart/financials";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame } from "../dialog/DialogParts";
import { CloseIcon } from "../icons";

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

export function FinancialUpdateDialog() {
  const shown = useSelectionStore((s) => s.dialog?.kind === "financial-update");
  return shown ? <UpdateDialog /> : null;
}

function UpdateDialog() {
  const close = useSelectionStore((s) => s.closeDialog);
  const client = useQueryClient();
  const query = useFinancialUpdate();
  const command = useMutation({ mutationFn: (action: "start" | "pause" | "resume") => commandFinancialUpdate(client, action) });
  const job = query.data;
  const active = updateActive(job?.status);
  const resume = job?.canResume;
  const title = job?.latestCheckPending ? "최신 공시 확인 대기" : job?.status === "ready" ? job.historyComplete ? "전체 이력 확인 완료" : "최근 자료 확인 완료 · 과거 이력 미수집" : job?.status === "collecting" && job.phase === "history" ? "과거 이력 수집 중" : job?.status === "collecting" && job.phase === "changes" ? "정정·실패 자료 수집 중" : job ? STATUS[job.status] : "";
  return (
    <DialogFrame labelledBy="financial-update-title" width="w-[560px] max-h-[80dvh]" onClose={close}>
      <header className="flex flex-none items-center gap-3 border-b border-line px-5 py-3">
        <h2 id="financial-update-title" className="flex-1 text-l font-semibold">재무자료</h2>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={close}><CloseIcon /></button>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p className="text-s leading-relaxed text-text-2">코스피·코스닥 전체 지원 회사의 최근 자료를 먼저 업데이트한 뒤 2015년 이후 과거 이력을 이어 받습니다. 차트는 저장된 자료를 사용합니다.</p>
        {query.isPending && <p role="status">현황을 불러오는 중</p>}
        {query.error && <div role="alert" className="text-s text-danger">{query.error.message} <button type="button" className="tb-btn" onClick={() => void query.refetch()}>다시 조회</button></div>}
        {job && <>
          <section className="rounded-m border border-line p-4" aria-label="업데이트 현황">
            <p role="status" className="font-semibold">{title}</p>
            {job.stopReason && <p className="mt-2 text-s text-text-2">정지 사유: {STOP[job.stopReason]}. {job.status === "pausing" ? "진행 중인 응답을 저장한 뒤 멈춥니다." : STOP_MESSAGE[job.stopReason]}</p>}
            {job.nextCheckAt !== null && <p className="mt-2 text-s text-text-2">{job.automatic ? "다음 자동 확인" : "다음 확인 기준"} (한국 시각): {checkedTime(job.nextCheckAt)}{job.stopReason === "rate_limited" ? ". 요청 하나가 성공하면 이어 받습니다." : ""}</p>}
            {job.latestCheckPending && <p className="mt-2 text-s text-text-2">진행 중인 응답을 저장한 뒤 최신 공시와 영향 자료부터 확인합니다.</p>}
            <p className="mt-1 text-s text-text-2">최근 {job.fromYear}~{job.throughYear} 사업연도 · 계산에 필요한 비교기간 포함</p>
            <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-s">
              <dt>현재 단계</dt><dd>{PHASE[job.phase]}</dd>
              <dt>대상 종목 확인</dt><dd>{job.processedSymbols} / {job.totalSymbols}종목</dd>
              <dt>최근 자료 완료</dt><dd>{job.completedCompanies} / {job.totalCompanies}회사</dd>
              <dt>과거 이력 완료</dt><dd>{job.historyCompletedCompanies} / {job.totalCompanies}회사</dd>
              <dt>전체 이력 확인</dt><dd>{job.historyComplete ? "완료" : "미완료"}</dd>
              <dt>실패 회사</dt><dd>{job.failedCompanies}회사</dd>
              <dt>미지원 상품</dt><dd>{job.unsupportedSymbols}종목</dd>
              <dt>공식 회사 연결 미확인</dt><dd>{job.unverifiedSymbols}종목</dd>
              <dt>배당 주식 종류 미확인</dt><dd>{job.unverifiedDividends}종목</dd>
            </dl>
            {(job.recentFailedCompanies > 0 || job.historyFailedCompanies > 0) && <p className="mt-2 text-xs text-text-2">최근 단계 실패 {job.recentFailedCompanies}회사 · 과거 단계 실패 {job.historyFailedCompanies}회사</p>}
            <p className="mt-4 border-t border-line pt-3 text-xs text-text-2">마지막 확인 {checkedTime(job.lastCheckedAt)}</p>
          </section>
          {job.status === "not_configured" && <p className="text-s text-text-2">서버의 OPENDART_API_KEY를 설정하면 업데이트할 수 있습니다. 저장된 자료는 계속 조회할 수 있습니다.</p>}
          {job.status === "partial_failure" && <p className="text-s text-text-2">일부 자료를 확인하지 못해 전체 이력 확인이 미완료입니다. 저장된 자료는 계속 사용할 수 있습니다.</p>}
          {job.failure && <p role="alert" className="text-s text-danger">{financialFailure(job.failure)} · 저장된 완료 지점을 유지합니다.</p>}
          {job.failures.length > 0 && <section aria-label="실패·미확인 목록">
            <h3 className="mb-2 text-s font-semibold">실패·미확인 목록</h3>
            <ul className="divide-y divide-line text-s">{job.failures.map((entry) => <li key={entry.code} className="py-2">
              <span className="font-medium">{entry.name}</span> <span className="text-xs text-text-3">{entry.code}</span>
              <p className="mt-0.5 text-text-2">{entry.failure ? financialFailure(entry.failure) : "공식 회사 연결 미확인"}</p>
            </li>)}</ul>
          </section>}
        </>}
        {command.error && <p role="alert" className="text-s text-danger">{command.error.message}</p>}
      </div>
      <footer className="flex flex-none justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" className="tb-btn" onClick={close}>닫기</button>
        {active ? <button type="button" className="tb-btn disabled:opacity-50" disabled={command.isPending || job?.status === "pausing" || job?.status === "checking"} onClick={() => command.mutate("pause")}>{job?.status === "checking" ? "확인 중" : job?.status === "pausing" ? "정지 중" : "일시정지"}</button> : <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!job || job.status === "not_configured" || command.isPending} onClick={() => command.mutate(resume ? "resume" : "start")}>
          {command.isPending ? "요청 중" : resume ? job?.status === "stopped" ? "확인 후 재개" : job?.status === "interrupted" ? "이어서 업데이트" : "재개" : "전체 업데이트"}
        </button>}
      </footer>
    </DialogFrame>
  );
}
