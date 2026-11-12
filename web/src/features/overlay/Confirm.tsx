import { create } from "zustand";
import { DialogFrame } from "../dialog/DialogParts";
interface Request { text: string; complete(confirmed: boolean): void }
const useConfirmation = create<{ request: Request | null }>(() => ({ request: null }));
export function confirmAction(text: string): Promise<boolean> {
  useConfirmation.getState().request?.complete(false);
  return new Promise((resolve) => useConfirmation.setState({ request: { text, complete: resolve } }));
}
export function ConfirmHost() {
  const request = useConfirmation((s) => s.request);
  if (!request) return null;
  const close = (confirmed: boolean) => { useConfirmation.setState({ request: null }); request.complete(confirmed); };
  return <DialogFrame labelledBy="confirm-title" width="w-[min(420px,calc(100vw-32px))]" onClose={() => close(false)}>
    <div className="ui-dialog-head"><h2 id="confirm-title">{request.text}</h2></div>
    <div className="ui-dialog-foot justify-end"><button autoFocus className="tb-btn" onClick={() => close(false)}>취소</button><button className="btn-primary" onClick={() => close(true)}>확인</button></div>
  </DialogFrame>;
}
