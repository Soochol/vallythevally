import { useFinancialJob } from "../../api/financialUpdate";
import { financialJobProgress, financialJobTone } from "../../lib/financialJob";
import { useSelectionStore } from "../../stores/selection";
import { TONE_CLASS } from "./tone";

export function FinancialUpdateButton({ className = "" }: { className?: string }) {
  const open = useSelectionStore((s) => s.openFinancialUpdate);
  const job = useFinancialJob().page;
  const progress = job ? financialJobProgress(job) : null;
  const tone = TONE_CLASS[financialJobTone(job?.status)];
  return <button type="button" data-financial-anchor className={`tb-btn flex-none gap-1.5 ${className}`} aria-label="재무자료" aria-haspopup="dialog" onClick={open}>
    <i aria-hidden="true" className={`size-1.5 flex-none rounded-full ${tone}`} />재무자료
    {progress && progress.total > 0 && <span aria-hidden="true" className="text-xs text-text-2">{Math.floor(progress.done / progress.total * 100)}%</span>}
  </button>;
}
