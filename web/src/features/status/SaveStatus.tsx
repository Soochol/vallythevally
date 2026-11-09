import { retryFailedSaves } from "../../persist/autosave";
import { type SaveIndicator, saveIndicator } from "../../persist/saveStatus";
import { usePersistStore } from "../../stores/persist";
import { CheckIcon } from "../icons";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 자동 저장 표시와 복원 실패 안내(frontend.md §3.7). 빨강은 쓰지 않는다. */
export function useSaveView(): { indicator: SaveIndicator; offline: string | null } {
  const saves = usePersistStore((s) => s.saves);
  const phase = usePersistStore((s) => s.phase);
  return { indicator: saveIndicator(saves), offline: phase.kind === "offline" ? phase.message : null };
}

const RETRY_BUTTON = "rounded-s px-1 font-[650] text-accent underline underline-offset-2 hover:bg-accent-soft";

/** 데스크톱 상태 줄의 자동 저장 표시. */
export function SaveStatus() {
  const { indicator, offline } = useSaveView();
  if (offline) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-accent" title={offline}>
        <span className="truncate">{offline}</span>
        <button type="button" className={RETRY_BUTTON} onClick={() => location.reload()}>
          다시 불러오기
        </button>
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
        <span className="flex items-center gap-1">
          <CheckIcon size={12} />
          자동 저장됨 {clock(indicator.at)}
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1 text-accent" role="alert">
          저장하지 못했습니다:
          <button type="button" className={RETRY_BUTTON} onClick={retryFailedSaves}>
            다시 시도
          </button>
        </span>
      );
    case "tooLarge":
      return (
        <span className="text-accent" role="alert">
          저장하지 못했습니다: 설정이 64KB를 넘습니다{indicator.hint ? `. ${indicator.hint}` : ""}
        </span>
      );
  }
}

/** 휴대폰에는 자동 저장 표시를 두지 않고, 저장하지 못할 때만 띠로 알린다(frontend.md §4). */
export function PhoneSaveBand() {
  const { indicator, offline } = useSaveView();
  const text = offline
    ? offline
    : indicator.kind === "failed"
      ? "저장하지 못했습니다"
      : indicator.kind === "tooLarge"
        ? "저장하지 못했습니다: 설정이 64KB를 넘습니다"
        : null;
  if (!text) return null;
  return (
    <div role="alert" className="fixed inset-x-0 bottom-[56px] z-40 flex items-center gap-2 border-t border-accent bg-accent-soft px-3 py-2 text-s text-text md:hidden">
      <span className="min-w-0 flex-1">{text}</span>
      {(offline || indicator.kind === "failed") && (
        <button type="button" className={RETRY_BUTTON} onClick={offline ? () => location.reload() : retryFailedSaves}>
          {offline ? "다시 불러오기" : "다시 시도"}
        </button>
      )}
    </div>
  );
}
