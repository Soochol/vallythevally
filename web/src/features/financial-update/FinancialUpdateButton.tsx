import { useSelectionStore } from "../../stores/selection";

export function FinancialUpdateButton({ className = "" }: { className?: string }) {
  const open = useSelectionStore((s) => s.openFinancialUpdate);
  return <button type="button" className={`tb-btn flex-none ${className}`} aria-haspopup="dialog" onClick={open}>재무자료</button>;
}
