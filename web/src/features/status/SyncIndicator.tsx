import { useAccountStore } from "../../stores/account";
import { openSystemSettings } from "../system-settings/open";
import { syncView } from "./syncView";

export function SyncIndicator() {
  const view = syncView(useAccountStore((s) => s.status));
  if (!view) return null;
  return (
    <button type="button" role="status" aria-label={`계정 동기화: ${view.label}`} title="계정 메뉴 열기" className="flex min-w-0 items-center gap-1.5 hover:text-text" onClick={() => openSystemSettings("account")}>
      <span aria-hidden="true" className="conn-dot" data-tone={view.tone} />
      <span className="min-w-0 truncate">{view.label}</span>
    </button>
  );
}
