import { useEffect, useRef, useState } from "react";
import { colorsFrom, KINDS, specName } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import { type Slot, useLayoutStore } from "../../stores/layout";
import { CloseIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { checkForm, startDraft } from "./indicatorForm";
import { IndicatorSettingsForm, useValidator } from "./IndicatorSettingsForm";

export function IndicatorPopover({ slot, initial, anchor, editRoot, onClose }: {
  slot: Slot;
  initial: IndicatorConfig;
  anchor: HTMLElement;
  editRoot: HTMLElement;
  onClose(): void;
}) {
  const trigger = useRef(anchor);
  const [draft, setDraft] = useState(() => startDraft(initial, initial.spec.kind));
  const validator = useValidator();
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const color = draft.color === "auto" ? initial.style.colors[0] ?? "ind-1" : draft.color;
  const originalColor = startDraft(initial, initial.spec.kind).color;

  useEffect(() => {
    if (!check.ok) return;
    const current = useLayoutStore.getState().layout.cells.find((cell) => cell.slot === slot)?.chartSettings.indicators.find((i) => i.id === initial.id);
    if (!current) return;
    const spec = JSON.stringify(current.spec) === JSON.stringify(check.spec) ? current.spec : check.spec;
    const colors = color === originalColor ? initial.style.colors : colorsFrom(spec, color);
    const style = current.style.width === draft.width && JSON.stringify(current.style.colors) === JSON.stringify(colors) ? current.style : { colors, width: draft.width };
    if (spec !== current.spec || style !== current.style) useLayoutStore.getState().updateIndicator(slot, initial.id, { spec, style });
  }, [draft, validator, slot, initial]);

  const close = (reason?: "escape" | "outside") => {
    if (reason === "escape") useLayoutStore.getState().updateIndicator(slot, initial.id, { spec: initial.spec, style: initial.style });
    onClose();
  };

  return <Popover isInside={(target) => target instanceof Element && editRoot.contains(target.closest("[data-indicator-edit]"))} anchor={trigger} onClose={close} role="dialog" aria-label={`${specName(initial.spec)} 설정`} data-chart-control="" className="w-[min(360px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] overflow-auto p-3">
    <div className="mb-3 flex items-center gap-2">
      <h3 className="flex-1 text-m font-semibold">{KINDS[initial.spec.kind].label}</h3>
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
