import { type ChangeEvent, useId, useLayoutEffect, useRef } from "react";
import { formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import { type EstimateNote, quantityForAmount } from "./orderRules";
import { AMOUNT_UNIT_WON, KEEP_LAST_ENTRY_LABEL, type PresetKind } from "./orderSettings";

const PRESET_KINDS = [{ value: "sharePresets", label: "수량" }, { value: "amountPresets", label: "금액" }] as const;

const NO_REFERENCE_PRICE_TEXT = "현재가를 아직 받지 못했습니다";

interface Props {
  readonly presetKind: PresetKind;
  readonly input: string;
  readonly sharePresets: readonly number[];
  readonly amountPresets: readonly number[];
  readonly referencePrice: number | null;
  readonly keepLastEntry: boolean;
  readonly onPresetKind: (kind: PresetKind) => void;
  readonly onInput: (input: string) => void;
}

export function QuantityRow({ presetKind, input, sharePresets, amountPresets, referencePrice, keepLastEntry, onPresetKind, onInput }: Props) {
  const inputId = useId();
  const field = useRef<HTMLInputElement>(null);
  const digitsBeforeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (digitsBeforeCaret.current === null || field.current === null) return;
    field.current.setSelectionRange(digitsBeforeCaret.current, digitsBeforeCaret.current);
    digitsBeforeCaret.current = null;
  }, [input]);
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const { value, selectionStart } = event.target;
    const digits = value.replace(/[^0-9]/g, "");
    const digitsBefore = value.slice(0, selectionStart ?? value.length).replace(/[^0-9]/g, "").length;
    if (digits === input) {
      const target = event.target;
      queueMicrotask(() => target.setSelectionRange(digitsBefore, digitsBefore));
      return;
    }
    digitsBeforeCaret.current = digitsBefore;
    onInput(digits);
  };
  const amountKind = presetKind === "amountPresets";
  const noPrice = amountKind && (referencePrice === null || !(referencePrice > 0));
  const fillAmount = (won: number) => onInput(String(quantityForAmount(won, referencePrice) ?? 0));
  return (
    <div className="od-qty" data-testid="order-quantity-row">
      <span className="od-qty-name">
        <label className="od-qty-label" htmlFor={inputId}>수량</label>
        {keepLastEntry && <span className="od-qty-keep" data-testid="order-keep-mark" title={KEEP_LAST_ENTRY_LABEL}>유지</span>}
      </span>
      <input id={inputId} ref={field} className="od-qty-input" inputMode="numeric" autoComplete="off" value={input} onChange={change} />
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
