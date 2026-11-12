import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FinancialUpdateStatus } from "../../api/generated/FinancialUpdateStatus";
import { startFinancialUpdate, updateActive, useFinancialUpdate } from "../../api/financialUpdate";
import { checkedTime, financialFailure } from "../../chart/financials";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame } from "../dialog/DialogParts";
import { CloseIcon } from "../icons";

const STATUS: Record<FinancialUpdateStatus, string> = {
  idle: "업데이트 전", planning: "대상 회사 확인 중", collecting: "최근 자료 수집 중", ready: "최근 자료 확인 완료",
  partial_failure: "일부 자료 확인 실패", interrupted: "중단된 작업 있음", failed: "업데이트 실패", not_configured: "DART 연동 미설정",
};

export function FinancialUpdateDialog() {
  const shown = useSelectionStore((s) => s.dialog?.kind === "financial-update");
  return shown ? <UpdateDialog /> : null;
}

function UpdateDialog() {
  const close = useSelectionStore((s) => s.closeDialog);
  const client = useQueryClient();
  const query = useFinancialUpdate();
  const start = useMutation({ mutationFn: () => startFinancialUpdate(client) });
  const job = query.data;
  const active = updateActive(job?.status);
  return (
    <DialogFrame labelledBy="financial-update-title" width="w-[560px] max-h-[80dvh]" onClose={close}>
      <header className="flex flex-none items-center gap-3 border-b border-line px-5 py-3">
        <h2 id="financial-update-title" className="flex-1 text-l font-semibold">재무자료</h2>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={close}><CloseIcon /></button>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p className="text-s leading-relaxed text-text-2">코스피·코스닥 전체 지원 회사의 최근 자료를 업데이트합니다. 차트는 저장된 자료를 사용합니다.</p>
        {query.isPending && <p role="status">현황을 불러오는 중</p>}
        {query.error && <div role="alert" className="text-s text-danger">{query.error.message} <button type="button" className="tb-btn" onClick={() => void query.refetch()}>다시 조회</button></div>}
        {job && <>
          <section className="rounded-m border border-line p-4" aria-label="업데이트 현황">
            <p role="status" className="font-semibold">{STATUS[job.status]}</p>
            <p className="mt-1 text-s text-text-2">최근 {job.fromYear}~{job.throughYear} 사업연도 · 계산에 필요한 비교기간 포함</p>
            <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-s">
              <dt>대상 종목 확인</dt><dd>{job.processedSymbols} / {job.totalSymbols}종목</dd>
              <dt>최근 자료 완료</dt><dd>{job.completedCompanies} / {job.totalCompanies}회사</dd>
              <dt>실패 회사</dt><dd>{job.failedCompanies}회사</dd>
              <dt>미지원 상품</dt><dd>{job.unsupportedSymbols}종목</dd>
              <dt>공식 회사 연결 미확인</dt><dd>{job.unverifiedSymbols}종목</dd>
              <dt>배당 주식 종류 미확인</dt><dd>{job.unverifiedDividends}종목</dd>
            </dl>
            <p className="mt-4 border-t border-line pt-3 text-xs text-text-2">마지막 확인 {checkedTime(job.lastCheckedAt)}</p>
          </section>
          {job.status === "not_configured" && <p className="text-s text-text-2">서버의 OPENDART_API_KEY를 설정하면 업데이트할 수 있습니다. 저장된 자료는 계속 조회할 수 있습니다.</p>}
          {job.status === "interrupted" && <p className="text-s text-text-2">저장된 완료 지점부터 이어서 업데이트합니다.</p>}
          {job.failure && <p role="alert" className="text-s text-danger">{financialFailure(job.failure)} · 저장된 완료 지점을 유지합니다.</p>}
          {job.failures.length > 0 && <section aria-label="실패·미확인 목록">
            <h3 className="mb-2 text-s font-semibold">실패·미확인 목록</h3>
            <ul className="divide-y divide-line text-s">{job.failures.map((entry) => <li key={entry.code} className="py-2">
              <span className="font-medium">{entry.name}</span> <span className="text-xs text-text-3">{entry.code}</span>
              <p className="mt-0.5 text-text-2">{entry.failure ? financialFailure(entry.failure) : "공식 회사 연결 미확인"}</p>
            </li>)}</ul>
          </section>}
        </>}
        {start.error && <p role="alert" className="text-s text-danger">{start.error.message}</p>}
      </div>
      <footer className="flex flex-none justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" className="tb-btn" onClick={close}>닫기</button>
        <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!job || active || job.status === "not_configured" || start.isPending} onClick={() => start.mutate()}>
          {active || start.isPending ? "업데이트 중" : job?.status === "interrupted" ? "이어서 업데이트" : "전체 업데이트"}
        </button>
      </footer>
    </DialogFrame>
  );
}
