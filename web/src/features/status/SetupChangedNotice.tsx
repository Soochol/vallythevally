import { useRef, useState } from "react";
import type { DocumentKind } from "../../api/generated/DocumentKind";
import { CloseIcon, InfoIcon } from "../icons";
import { saveBeforeReload } from "./saveBeforeReload";
import { saveFailureText, useSaveView } from "./SaveStatus";
import { useSelectionStore } from "../../stores/selection";
import { useSetupChangeStore } from "../../stores/setupChange";

export const SETUP_CHANGED_TEXT = "다른 PC에서 바뀐 셋업이 있습니다";
const SAVE_FAILED_TEXT = "저장하지 못해 새로 고치지 않았습니다. 저장이 끝난 뒤 다시 누르세요";

const KIND_NAMES: Record<DocumentKind, string> = {
  watchlists: "관심종목",
  screens: "스크리너 화면",
  ui_state: "화면 설정",
  layout: "레이아웃",
  drawing: "드로잉",
  heatmap_themes: "히트맵 테마",
};

export const setupChangedText = (kinds: readonly DocumentKind[]): string => `${SETUP_CHANGED_TEXT}: ${kinds.map((kind) => KIND_NAMES[kind]).join(", ")}`;

export function SetupChangedNotice() {
  const kinds = useSetupChangeStore((s) => s.kinds);
  const { indicator, offline } = useSaveView();
  const hasPhoneSaveBand = Boolean(offline ?? saveFailureText(indicator));
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  if (kinds.length === 0) return null;

  const refresh = async () => {
    const mine = ++attempt.current;
    setBusy(true);
    try {
      await saveBeforeReload();
    } catch {
      if (attempt.current !== mine) return;
      useSelectionStore.getState().showToast(SAVE_FAILED_TEXT);
      setBusy(false);
      return;
    }
    if (attempt.current === mine) location.reload();
  };

  const dismiss = () => {
    attempt.current++;
    setBusy(false);
    useSetupChangeStore.getState().dismiss();
  };

  return (
    <div role="status" data-tone="info" className={`ui-toast fixed bottom-10 right-3 z-[var(--z-notice)] max-md:inset-x-3 ${hasPhoneSaveBand ? "max-md:bottom-28" : "max-md:bottom-16"}`}>
      <span className="ui-toast-icon"><InfoIcon /></span>
      <span className="ui-toast-text">{setupChangedText(kinds)}</span>
      <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void refresh()}>새로 고침</button>
      <button type="button" className="icon-btn ui-toast-close" aria-label="나중에" title="나중에" onClick={dismiss}><CloseIcon /></button>
    </div>
  );
}
