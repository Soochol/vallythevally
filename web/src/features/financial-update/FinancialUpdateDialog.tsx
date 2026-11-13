import { Fragment, type ReactNode, useState } from "react";
import { useFinancialJob } from "../../api/financialUpdate";
import { financialFailure } from "../../chart/financials";
import { financialJobAction, financialJobView } from "../../lib/financialJob";
import { useSelectionStore } from "../../stores/selection";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { DialogFrame } from "../dialog/DialogParts";
import { Popover } from "../overlay/Popover";
import { CloseIcon } from "../icons";
import { TONE_CLASS } from "./tone";

export function FinancialUpdateDialog() {
  const shown = useSelectionStore((s) => s.dialog?.kind === "financial-update");
  return shown ? <UpdateDialog /> : null;
}

function UpdateDialog() {
  const close = useSelectionStore((s) => s.closeDialog);
  const { page: job, query, command } = useFinancialJob();
  const view = job && financialJobView(job, command.pending);
  const action = financialJobAction(job, command.pending);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [detailed, setDetailed] = useState(false);
  const content = <>
      <header className="flex flex-none items-center gap-3 border-b border-line px-4 py-2">
        <h2 id="financial-update-title" className="flex-1 text-m font-semibold">재무자료</h2>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={close}><CloseIcon /></button>
      </header>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        {query.isPending && <p role="status">현황을 불러오는 중</p>}
        {query.error && <div role="alert" className="text-s text-danger">{query.error.message} <button type="button" className="tb-btn" onClick={() => void query.refetch()}>다시 조회</button></div>}
        {job && view && <>
          <section aria-label="업데이트 현황" className="flex flex-col gap-2">
            <p role="status" className="flex items-center gap-2 font-semibold"><i aria-hidden="true" className={`size-2 flex-none rounded-full ${TONE_CLASS[view.statusTone]}`} />{view.title}</p>
            {view.progress && <>
              <progress aria-label="재무 업데이트 진행률" className="h-1.5 w-full accent-accent" value={view.progress.done} max={Math.max(1, view.progress.total)} />
              <p className="text-s text-text-2">{view.progress.text}</p>
            </>}
            {view.stopNote && <p className="text-s text-text-2">{view.stopNote}</p>}
            {view.nextCheckNote && <p className="text-s text-text-2">{view.nextCheckNote}</p>}
            {view.latestCheckNote && <p className="text-s text-text-2">{view.latestCheckNote}</p>}
            {view.failedCompaniesNote && <p className="rounded-m bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-s text-warning">{view.failedCompaniesNote}</p>}
          </section>
          {view.notice && <p className="text-s text-text-2">{view.notice}</p>}
          {view.failureNote && <p role="alert" className="text-s text-danger">{view.failureNote}</p>}
          <button type="button" className="tb-btn h-7 self-start px-2 text-s text-text-2" aria-expanded={detailed} aria-controls="financial-update-details" onClick={() => setDetailed(!detailed)}>{detailed ? "간단히" : "자세히"}</button>
          <div id="financial-update-details" hidden={!detailed} className="flex flex-col gap-3">
            <p className="text-s leading-relaxed text-text-2">코스피·코스닥 전체 지원 회사의 최근 자료를 먼저 업데이트한 뒤 2015년 이후 과거 이력을 이어 받습니다. 차트는 저장된 자료를 사용합니다.</p>
            <p className="text-s text-text-2">{view.yearsNote}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-s">
              {view.rows.map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}
            </dl>
            {view.phaseFailureNote && <p className="text-xs text-text-2">{view.phaseFailureNote}</p>}
            <p className="border-t border-line pt-3 text-xs text-text-2">{view.lastCheckedNote}</p>
            {job.failures.length > 0 && <section aria-label="실패·미확인 목록">
              <h3 className="mb-2 text-s font-semibold">실패·미확인 목록</h3>
              <ul className="divide-y divide-line text-s">{job.failures.map((entry) => <li key={entry.code} className="py-2">
                <span className="font-medium">{entry.name}</span> <span className="text-xs text-text-3">{entry.code}</span>
                <p className="mt-0.5 text-text-2">{entry.failure ? financialFailure(entry.failure) : "공식 회사 연결 미확인"}</p>
              </li>)}</ul>
            </section>}
          </div>
        </>}
        {command.error && <p role="alert" className="text-s text-danger">{command.error.message}</p>}
      </div>
      <footer className="flex flex-none justify-end gap-2 border-t border-line px-4 py-3">
        <button type="button" className="tb-btn" onClick={close}>닫기</button>
        <button type="button" className={action.command === "pause" ? "tb-btn disabled:opacity-50" : "btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50"} disabled={action.disabled} onClick={() => command.run(action.command)}>{action.label}</button>
      </footer>
  </>;
  return <Surface desktop={desktop} onClose={close}>{content}</Surface>;
}

function Surface({ desktop, onClose, children }: { desktop: boolean; onClose(): void; children: ReactNode }) {
  if (!desktop) return <DialogFrame labelledBy="financial-update-title" width="w-[560px] max-h-[80dvh]" onClose={onClose}>{children}</DialogFrame>;
  const anchor = () => [...document.querySelectorAll<HTMLElement>("[data-financial-anchor]")].find((node) => node.getClientRects().length > 0)?.getBoundingClientRect();
  return <Popover role="dialog" aria-labelledby="financial-update-title" anchorRect={anchor} onClose={onClose} className="flex max-h-[80dvh] w-[380px] flex-col">{children}</Popover>;
}
