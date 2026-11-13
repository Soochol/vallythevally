import { Fragment } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commandFinancialUpdate, useFinancialUpdate } from "../../api/financialUpdate";
import { financialFailure } from "../../chart/financials";
import { financialJobView, type FinancialJobCommand } from "../../lib/financialJob";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame } from "../dialog/DialogParts";
import { CloseIcon } from "../icons";

export function FinancialUpdateDialog() {
  const shown = useSelectionStore((s) => s.dialog?.kind === "financial-update");
  return shown ? <UpdateDialog /> : null;
}

function UpdateDialog() {
  const close = useSelectionStore((s) => s.closeDialog);
  const client = useQueryClient();
  const query = useFinancialUpdate();
  const command = useMutation({ mutationFn: (action: FinancialJobCommand) => commandFinancialUpdate(client, action) });
  const job = query.data;
  const view = job && financialJobView(job, command.isPending);
  const action = view?.action ?? { command: "start", label: command.isPending ? "요청 중" : "전체 업데이트", disabled: true };
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
        {job && view && <>
          <section className="rounded-m border border-line p-4" aria-label="업데이트 현황">
            <p role="status" className="font-semibold">{view.title}</p>
            {view.stopNote && <p className="mt-2 text-s text-text-2">{view.stopNote}</p>}
            {view.nextCheckNote && <p className="mt-2 text-s text-text-2">{view.nextCheckNote}</p>}
            {view.latestCheckNote && <p className="mt-2 text-s text-text-2">{view.latestCheckNote}</p>}
            <p className="mt-1 text-s text-text-2">{view.yearsNote}</p>
            <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-s">
              {view.rows.map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}
            </dl>
            {view.phaseFailureNote && <p className="mt-2 text-xs text-text-2">{view.phaseFailureNote}</p>}
            <p className="mt-4 border-t border-line pt-3 text-xs text-text-2">{view.lastCheckedNote}</p>
          </section>
          {view.notice && <p className="text-s text-text-2">{view.notice}</p>}
          {view.failureNote && <p role="alert" className="text-s text-danger">{view.failureNote}</p>}
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
        <button type="button" className={action.command === "pause" ? "tb-btn disabled:opacity-50" : "btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50"} disabled={action.disabled} onClick={() => command.mutate(action.command)}>{action.label}</button>
      </footer>
    </DialogFrame>
  );
}
