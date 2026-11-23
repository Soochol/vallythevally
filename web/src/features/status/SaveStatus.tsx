import { formatKstClockSeconds } from "../../chart/time";
import { retryFailedSaves } from "../../persist/autosave";
import { type SaveIndicator, saveIndicator } from "../../persist/saveStatus";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { usePersistStore } from "../../stores/persist";
import { CheckIcon, WarningIcon } from "../icons";
import { useDrawingSave } from "../../chart/drawings/sync";
import { STATUS_BUTTON } from "./statusButton";

export const retryAll = () => { retryFailedSaves(); useDrawingSave.getState().retry(); };

const savedClock = (at: number, origin: number | null): string => formatKstClockSeconds(at / 1000 + (serverNow(origin) - Date.now()) / 1000);

export function useSaveView(): { indicator: SaveIndicator; offline: string | null } {
  const saves = usePersistStore((s) => s.saves);
  const phase = usePersistStore((s) => s.phase);
  const drawing = useDrawingSave((s) => s.state);
  return { indicator: saveIndicator(saves, drawing), offline: phase.kind === "offline" ? phase.message : null };
}

export function saveFailureText(indicator: SaveIndicator): string | null {
  switch (indicator.kind) {
    case "failed":
      return "저장하지 못했습니다";
    case "tooLarge":
      return `저장하지 못했습니다: 설정이 64KB를 넘습니다${indicator.hint ? `. ${indicator.hint}` : ""}`;
    default:
      return null;
  }
}

export function SaveStatus() {
  const { indicator, offline } = useSaveView();
  const origin = useServerClock((s) => s.serverTimeOrigin);
  if (offline) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-warning" title={offline}>
        <WarningIcon size={12} />
        <span className="truncate">저장 안 됨</span>
      </span>
    );
  }
  switch (indicator.kind) {
    case "hidden":
      return null;
    case "busy":
      return <span className="text-text-3">저장 중…</span>;
    case "saved":
      return (
        <span className="flex items-center gap-1.5" title={`마지막 저장 ${savedClock(indicator.at, origin)}`}>
          <CheckIcon size={12} />
          저장됨
        </span>
      );
    case "failed":
    case "tooLarge":
      return (
        <span className="flex items-center gap-1.5 text-warning" title={saveFailureText(indicator) ?? undefined}>
          <WarningIcon size={12} />
          저장 실패
        </span>
      );
  }
}

export function PhoneSaveBand() {
  const { indicator, offline } = useSaveView();
  const text = offline ?? saveFailureText(indicator);
  if (!text) return null;
  return (
    <div role="alert" data-testid="phone-save-band" className="fixed inset-x-0 bottom-[56px] z-40 flex items-center gap-2 border-t border-warning bg-[color-mix(in_srgb,var(--warning)_24%,var(--surface))] px-3 py-2 text-s text-text md:hidden">
      <span className="min-w-0 flex-1">{text}</span>
      {(offline || indicator.kind === "failed") && (
        <button type="button" className={STATUS_BUTTON} onClick={offline ? () => location.reload() : retryAll}>
          {offline ? "다시 불러오기" : "다시 시도"}
        </button>
      )}
    </div>
  );
}
