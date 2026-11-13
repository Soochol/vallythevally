import { updateActive, updateProgress, useFinancialUpdate } from "../../api/financialUpdate";
import { useSelectionStore } from "../../stores/selection";

export function FinancialUpdateButton({ className = "" }: { className?: string }) {
  const open = useSelectionStore((s) => s.openFinancialUpdate);
  const job = useFinancialUpdate().data;
  const active = updateActive(job?.status);
  const progress = job && active ? updateProgress(job) : null;
  const tone = !job || job.status === "idle" ? "bg-text-3" : active ? "bg-accent" : job.status === "ready" ? "bg-success" : "bg-warning";
  return <button type="button" data-financial-anchor className={`tb-btn flex-none gap-1.5 ${className}`} aria-label="재무자료" aria-haspopup="dialog" onClick={open}>
    <i aria-hidden="true" className={`size-1.5 flex-none rounded-full ${tone}`} />재무자료
    {progress && progress.total > 0 && <span aria-hidden="true" className="text-xs text-text-2">{Math.floor(progress.done / progress.total * 100)}%</span>}
  </button>;
}
