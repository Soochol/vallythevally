import { useState } from "react";
import { saveAllAndWait } from "../../persist/autosave";
import { useSelectionStore } from "../../stores/selection";
import { useSetupChangeStore } from "../../stores/setupChange";

export const SETUP_CHANGED_TEXT = "다른 PC에서 바뀐 셋업이 있습니다";
const SAVE_FAILED_TEXT = "저장하지 못해 새로 고치지 않았습니다. 저장이 끝난 뒤 다시 누르세요";

export function SetupChangedNotice() {
  const changed = useSetupChangeStore((s) => s.kinds.length > 0);
  const [busy, setBusy] = useState(false);
  if (!changed) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      await saveAllAndWait();
    } catch {
      useSelectionStore.getState().showToast(SAVE_FAILED_TEXT);
      setBusy(false);
      return;
    }
    location.reload();
  };

  return (
    <div role="status" className="fixed bottom-10 right-3 z-50 flex items-center gap-3 rounded-m border border-line bg-surface px-3 py-2 text-m shadow-dialog max-md:inset-x-3 max-md:bottom-16">
      <span className="min-w-0 flex-1">{SETUP_CHANGED_TEXT}</span>
      <button type="button" className="btn-primary h-8 px-3 disabled:opacity-50" disabled={busy} onClick={() => void refresh()}>새로 고침</button>
      <button type="button" className="tb-btn h-8 px-2" disabled={busy} onClick={() => useSetupChangeStore.setState({ kinds: [] })}>나중에</button>
    </div>
  );
}
