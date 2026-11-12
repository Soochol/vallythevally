import { Popover } from "../overlay/Popover";
import { useEffect } from "react";
import { useSelectionStore } from "../../stores/selection";

const TOAST_MS = 6000;

export function Toast() {
  const toast = useSelectionStore((s) => s.toast);
  const clearToast = useSelectionStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => clearToast(toast.id), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, clearToast]);

  if (!toast) return null;
  return <Popover key={toast.id} focus={false} restoreFocus={false} onClose={() => clearToast(toast.id)} role="status" className="ui-toast">
    <span>{toast.text}</span>
    {toast.undo && <button className="tb-btn" onClick={() => { toast.undo?.(); clearToast(toast.id); }}>되돌리기</button>}
  </Popover>;
}
