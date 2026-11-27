import { useAccountStore } from "../../stores/account";
import { SyncIcon } from "../icons";
import { openSystemSettings } from "../system-settings/open";
import type { ConnectionTone } from "./connectionView";
import { STATUS_BUTTON } from "./statusButton";
import { syncView } from "./syncView";

const TONE_TEXT: Record<ConnectionTone, string> = { gray: "text-text-3", mint: "text-success", amber: "text-warning", red: "text-danger" };

export function SyncIndicator() {
  const view = syncView(useAccountStore((s) => s.status));
  if (!view) return null;
  return (
    <span role="status" aria-label={`계정 동기화: ${view.label}`} className="inline-flex min-w-0">
      <button type="button" title="계정 메뉴 열기" className={`${STATUS_BUTTON} min-w-0`} onClick={() => openSystemSettings("account")}>
        <span aria-hidden="true" data-tone={view.tone} className={`flex flex-none ${TONE_TEXT[view.tone]}`}><SyncIcon /></span>
        <span className="min-w-0 truncate">{view.label}</span>
      </button>
    </span>
  );
}
