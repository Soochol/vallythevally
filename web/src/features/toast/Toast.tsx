import { useEffect } from "react";
import { useSelectionStore } from "../../stores/selection";

const TOAST_MS = 6000;

/** 화면 아래 알림 한 줄. 6초 뒤 사라진다(frontend.md §3.7a). */
export function Toast() {
  const toast = useSelectionStore((s) => s.toast);
  const clearToast = useSelectionStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => clearToast(toast.id), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast, clearToast]);

  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-10 z-[60] flex justify-center px-4 max-md:bottom-[72px]">
      {toast && (
        <p className="pointer-events-auto rounded-m border border-line bg-surface px-4 py-2 text-m text-text shadow-dialog">
          {toast.text}
        </p>
      )}
    </div>
  );
}
