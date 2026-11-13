import { Popover } from "../overlay/Popover";
import { useEffect, useSyncExternalStore } from "react";
import { useSelectionStore, type ToastUndo } from "../../stores/selection";

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
  return <Popover key={toast.id} focus={false} blockChartKeys={false} restoreFocus={false} onClose={() => clearToast(toast.id)} role="status" className="ui-toast">
    <i aria-hidden="true" className="size-1.5 flex-none rounded-full bg-success" />
    <span>{toast.text}</span>
    {toast.undo && <UndoButton action={toast.undo} close={() => clearToast(toast.id)} />}
  </Popover>;
}

function UndoButton({ action, close }: { action: ToastUndo; close(): void }) {
  const enabled = useSyncExternalStore(action.subscribe, action.available);
  return <button className="tb-btn h-7 border border-line px-2 text-s disabled:cursor-not-allowed disabled:opacity-40" disabled={!enabled} onClick={() => { action.run(); close(); }}>되돌리기</button>;
}
