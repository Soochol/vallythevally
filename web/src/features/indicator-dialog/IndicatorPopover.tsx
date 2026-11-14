import { useRef } from "react";
import { KINDS, specName } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { CloseIcon, DRAWING_ICONS, EyeIcon, Icon } from "../icons";
import { Popover } from "../overlay/Popover";
import { IndicatorSettingsForm } from "./IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "./liveDraft";
import type { WindowId } from "../../layout/kinds";

export function IndicatorPopover({ cellId, initial, anchor, editRoot, onClose }: {
  cellId: WindowId;
  initial: IndicatorConfig;
  anchor: HTMLElement;
  editRoot: HTMLElement;
  onClose(): void;
}) {
  const trigger = useRef(anchor);
  const { draft, setDraft, validator, check, color, revert } = useLiveIndicatorDraft(cellId, initial);
  const shown = useLayoutStore((s) => chartWindows(s.layout).find((cell) => cell.id === cellId)?.chartSettings.indicators.find((i) => i.id === initial.id)?.visible ?? true);

  const close = (reason?: "escape" | "outside") => {
    if (reason === "escape") revert();
    onClose();
  };

  return <Popover isInside={(target) => target instanceof Element && editRoot.contains(target.closest("[data-indicator-edit]"))} anchor={trigger} onClose={close} role="dialog" aria-label={`${specName(initial.spec)} 설정`} data-chart-control="" className="w-[min(360px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] overflow-auto p-3">
    <div className="mb-3 flex items-center gap-2">
      <h3 className="flex-1 text-m font-semibold">{KINDS[initial.spec.kind].label}</h3>
      <button type="button" className="icon-btn" aria-label={shown ? "지표 숨기기" : "지표 보이기"} aria-pressed={!shown} title={shown ? "숨기기" : "보이기"} onClick={() => useLayoutStore.getState().updateIndicator(cellId, initial.id, { visible: !shown })}><EyeIcon size={16} /></button>
      <button type="button" className="icon-btn text-danger" aria-label="지표 지우기" title="지우기" onClick={() => { useLayoutStore.getState().removeIndicator(cellId, initial.id); onClose(); }}><Icon path={DRAWING_ICONS.trash} size={16} /></button>
      <button type="button" className="icon-btn" aria-label="설정 닫기" onClick={() => close()}><CloseIcon size={16} /></button>
    </div>
    <div role="group" aria-label="설정값" className="flex flex-col gap-3">
      <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} />
      {check.errors.filter((error) => !KINDS[draft.form.kind].fields.some((f) => f.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
    </div>
    <p className="mt-3 text-xs text-text-3">즉시 반영 · Esc로 되돌리기</p>
  </Popover>;
}
