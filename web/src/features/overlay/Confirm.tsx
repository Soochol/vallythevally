import { create } from "zustand";
import { DialogFrame } from "../dialog/DialogParts";
interface Request { text: string; detail: readonly string[]; action: string; danger: boolean; complete(confirmed: boolean): void }
interface ConfirmOptions { action?: string; danger?: boolean; detail?: readonly string[] }
const useConfirmation = create<{ request: Request | null }>(() => ({ request: null }));
export function confirmAction(text: string, { action = "확인", danger = false, detail = [] }: ConfirmOptions = {}): Promise<boolean> {
  useConfirmation.getState().request?.complete(false);
  return new Promise((resolve) => useConfirmation.setState({ request: { text, detail, action, danger, complete: resolve } }));
}
export function ConfirmHost() {
  const request = useConfirmation((s) => s.request);
  if (!request) return null;
  const close = (confirmed: boolean) => { useConfirmation.setState({ request: null }); request.complete(confirmed); };
  return <DialogFrame labelledBy="confirm-title" width="w-[min(420px,calc(100vw-32px))]" size="compact" onClose={() => close(false)}>
    <div className="ui-dialog-head"><h2 id="confirm-title">{request.text}</h2></div>
    {request.detail.length > 0 && <ul className="ui-confirm-detail">{request.detail.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    <div className="ui-dialog-foot justify-end"><button autoFocus type="button" className="btn" onClick={() => close(false)}>취소</button><button type="button" className={request.danger ? "btn-danger" : "btn-primary"} onClick={() => close(true)}>{request.action}</button></div>
  </DialogFrame>;
}
