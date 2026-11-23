import { useFinancialJob } from "../../api/financialUpdate";
import { financialButtonView } from "../../lib/financialJob";
import { useSelectionStore } from "../../stores/selection";
import { DOT_CLASS, TEXT_CLASS } from "./tone";

export function FinancialUpdateButton({ className = "" }: { className?: string }) {
  const open = useSelectionStore((s) => s.openFinancialUpdate);
  const view = financialButtonView(useFinancialJob().page);
  return <button type="button" data-financial-anchor data-tone={view.tone} className={`tb-btn flex-none gap-1.5 ${className}`} aria-label="재무자료" aria-description={view.text ?? undefined} aria-haspopup="dialog" onClick={open}>
    {view.dot && <i aria-hidden="true" data-financial-dot className={`size-1.5 flex-none rounded-full ${DOT_CLASS[view.tone]}`} />}재무자료
    {view.text && <span aria-hidden="true" data-financial-state className={`text-xs font-medium ${TEXT_CLASS[view.tone]}`}>{view.text}</span>}
  </button>;
}
