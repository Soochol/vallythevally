import { create } from "zustand";
import { DialogFrame } from "../dialog/DialogParts";
interface Request { text: string; action: string; danger: boolean; complete(confirmed: boolean): void }
const useConfirmation = create<{ request: Request | null }>(() => ({ request: null }));
export function confirmAction(text: string, { action = "확인", danger = false }: { action?: string; danger?: boolean } = {}): Promise<boolean> {
  useConfirmation.getState().request?.complete(false);
  return new Promise((resolve) => useConfirmation.setState({ request: { text, action, danger, complete: resolve } }));
}
export function ConfirmHost() {
  const request = useConfirmation((s) => s.request);
  if (!request) return null;
  const close = (confirmed: boolean) => { useConfirmation.setState({ request: null }); request.complete(confirmed); };
  return <DialogFrame labelledBy="confirm-title" width="w-[min(420px,calc(100vw-32px))]" onClose={() => close(false)}>
    <div className="px-5 pb-2 pt-5"><h2 id="confirm-title" className="text-m font-semibold leading-snug">{request.text}</h2></div>
    <div className="flex justify-end gap-2 px-5 pb-4 pt-3"><button autoFocus className="tb-btn h-8" onClick={() => close(false)}>취소</button><button className={request.danger ? "tb-btn h-8 bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-3 font-semibold text-danger" : "btn-primary h-8"} onClick={() => close(true)}>{request.action}</button></div>
  </DialogFrame>;
}
