import { type ChangeEvent, useId } from "react";
import { formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import { type EstimateNote, quantityForAmount } from "./orderRules";
import { AMOUNT_UNIT_WON, type PresetKind } from "./orderSettings";

const PRESET_KINDS = [{ value: "sharePresets", label: "수량" }, { value: "amountPresets", label: "금액" }] as const;

const NO_REFERENCE_PRICE_TEXT = "현재가를 아직 받지 못했습니다";

interface Props {
  readonly presetKind: PresetKind;
  readonly input: string;
  readonly sharePresets: readonly number[];
  readonly amountPresets: readonly number[];
  readonly referencePrice: number | null;
  readonly onPresetKind: (kind: PresetKind) => void;
  readonly onInput: (input: string) => void;
}

export function QuantityRow({ presetKind, input, sharePresets, amountPresets, referencePrice, onPresetKind, onInput }: Props) {
  const inputId = useId();
  const change = (event: ChangeEvent<HTMLInputElement>) => onInput(event.target.value.replace(/[^0-9]/g, ""));
  const amountKind = presetKind === "amountPresets";
  const noPrice = amountKind && (referencePrice === null || !(referencePrice > 0));
  const fillAmount = (won: number) => onInput(String(quantityForAmount(won, referencePrice) ?? 0));
  return (
    <div className="od-qty" data-testid="order-quantity-row">
      <label className="od-qty-label" htmlFor={inputId}>수량</label>
      <input id={inputId} className="od-qty-input" inputMode="numeric" autoComplete="off" value={input} onChange={change} />
      <Segmented label="수량 방식" options={PRESET_KINDS} value={presetKind} onChange={onPresetKind} />
      <div className="od-presets" role="group" aria-label="수량 프리셋">
        {amountKind
          ? amountPresets.map((man) => <button key={man} type="button" className="od-preset" disabled={noPrice} title={noPrice ? NO_REFERENCE_PRICE_TEXT : undefined} onClick={() => fillAmount(man * AMOUNT_UNIT_WON)}>{`${man}만`}</button>)
          : sharePresets.map((shares) => <button key={shares} type="button" className="od-preset" onClick={() => onInput(String(shares))}>{shares}</button>)}
      </div>
    </div>
  );
}

interface EstimateProps {
  readonly estimate: number | null;
  readonly note: EstimateNote | null;
}

export function OrderEstimate({ estimate, note }: EstimateProps) {
  return (
    <div className="od-estimate">
      <span className="od-estimate-amount" title={estimate === null ? undefined : `예상 주문금액 ${formatWon(estimate)}`}>예상 주문금액 <b data-testid="order-estimate">{estimate === null ? "-" : formatWon(estimate)}</b>{note && <span className="od-estimate-note" data-testid="order-estimate-note" data-tone={note.tone}> · {note.text}</span>}</span>
    </div>
  );
}
