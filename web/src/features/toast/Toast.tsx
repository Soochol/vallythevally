import { Popover } from "../overlay/Popover";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSelectionStore, visibleToasts, type ToastEntry, type ToastTone, type ToastUndo } from "../../stores/selection";
import { CheckCircleIcon, CloseIcon, InfoIcon, WarningIcon } from "../icons";
import { Kbd } from "../ui/Kbd";

const TOAST_MS = 6000;
const KEEP_OPEN = () => undefined;

const TONE_ICON: Record<ToastTone, () => React.ReactNode> = {
  info: () => <InfoIcon />,
  success: () => <CheckCircleIcon />,
  warning: () => <WarningIcon />,
  error: () => <WarningIcon />,
};

export function Toast() {
  const toasts = useSelectionStore((s) => visibleToasts(s));
  if (toasts.length === 0) return null;
  return <Popover key={toasts[toasts.length - 1]!.id} dismiss={false} focus={false} blockChartKeys={false} restoreFocus={false} onClose={KEEP_OPEN} data-layer-passthrough="" className="ui-toast-stack">
    {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}
  </Popover>;
}

function ToastItem({ toast }: { toast: ToastEntry }) {
  const clearToast = useSelectionStore((s) => s.clearToast);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const persistent = toast.tone === "error";
  useEffect(() => {
    if (persistent || held) return;
    const id = setTimeout(() => clearToast(toast.id), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast.id, persistent, held, clearToast]);
  const close = () => clearToast(toast.id);
  return <div role={persistent ? "alert" : "status"} data-tone={toast.tone} className="ui-toast"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="ui-toast-icon">{TONE_ICON[toast.tone]()}</span>
    <span className="ui-toast-text">{toast.text}</span>
    {toast.undo && <UndoButton action={toast.undo} close={close} />}
    <button type="button" className="icon-btn ui-toast-close" aria-label="알림 닫기" onClick={close}><CloseIcon /></button>
  </div>;
}

function UndoButton({ action, close }: { action: ToastUndo; close(): void }) {
  const enabled = useSyncExternalStore(action.subscribe, action.available);
  return <button className="btn btn-sm gap-1.5" disabled={!enabled} aria-keyshortcuts={action.shortcut === undefined ? undefined : "Control+Z Meta+Z"} onClick={() => { action.run(); close(); }}>되돌리기{action.shortcut && <Kbd aria-hidden="true">{action.shortcut}</Kbd>}</button>;
}
