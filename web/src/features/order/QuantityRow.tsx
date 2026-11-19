import { type ChangeEvent, type KeyboardEvent, useId, useLayoutEffect, useRef } from "react";
import { formatQuantity, formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import type { QuantityMode } from "./orderRules";
import { AMOUNT_UNIT_WON } from "./orderSettings";

const MODES = [{ value: "shares", label: "수량" }, { value: "amount", label: "금액" }] as const;

const presetLabel = (mode: QuantityMode, value: number): string => (mode === "shares" ? String(value) : `${value / 10_000}만`);

const groupedDigits = (digits: string): string => digits.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const caretAfterDigits = (text: string, digitCount: number): number => {
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (seen === digitCount) return index;
    if (text[index] !== ",") seen += 1;
  }
  return text.length;
};

interface Props {
  readonly mode: QuantityMode;
  readonly input: string;
  readonly sharePresets: readonly number[];
  readonly amountPresets: readonly number[];
  readonly onMode: (mode: QuantityMode) => void;
  readonly onInput: (input: string) => void;
}

export function QuantityRow({ mode, input, sharePresets, amountPresets, onMode, onInput }: Props) {
  const inputId = useId();
  const label = mode === "shares" ? "수량" : "금액";
  const shown = mode === "amount" ? groupedDigits(input) : input;
  const field = useRef<HTMLInputElement>(null);
  const digitsBeforeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (digitsBeforeCaret.current === null || field.current === null) return;
    const caret = caretAfterDigits(shown, digitsBeforeCaret.current);
    field.current.setSelectionRange(caret, caret);
    digitsBeforeCaret.current = null;
  }, [shown]);
  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const { value, selectionStart } = event.target;
    digitsBeforeCaret.current = value.slice(0, selectionStart ?? value.length).replace(/[^0-9]/g, "").length;
    onInput(value.replace(/[^0-9]/g, ""));
  };
  const skipComma = (event: KeyboardEvent<HTMLInputElement>) => {
    const { value, selectionStart, selectionEnd } = event.currentTarget;
    if (mode !== "amount" || selectionStart === null || selectionStart !== selectionEnd) return;
    const target = event.key === "Backspace" ? selectionStart - 1 : event.key === "Delete" ? selectionStart : -1;
    if (value[target] !== ",") return;
    event.preventDefault();
    const caret = event.key === "Backspace" ? selectionStart - 1 : selectionStart + 1;
    event.currentTarget.setSelectionRange(caret, caret);
  };
  const presets = mode === "shares" ? sharePresets : amountPresets.map((man) => man * AMOUNT_UNIT_WON);
  return (
    <div className="od-qty" data-mode={mode} data-testid="order-quantity-row">
      <label className="od-qty-label" htmlFor={inputId}>{label}</label>
      <input id={inputId} ref={field} className="od-qty-input" inputMode="numeric" autoComplete="off" value={shown} onChange={change} onKeyDown={skipComma} />
      <Segmented label="수량 방식" options={MODES} value={mode} onChange={onMode} />
      <div className="od-presets" role="group" aria-label="수량 프리셋">
        {presets.map((value) => <button key={value} type="button" className="od-preset" onClick={() => onInput(String(value))}>{presetLabel(mode, value)}</button>)}
      </div>
    </div>
  );
}

interface EstimateProps {
  readonly estimate: number | null;
  readonly shares: number | null;
}

export function OrderEstimate({ estimate, shares }: EstimateProps) {
  return (
    <div className="od-estimate">
      <span className="od-estimate-amount">예상 주문금액 <b data-testid="order-estimate">{estimate === null ? "-" : formatWon(estimate)}</b></span>
      {shares !== null && <span className="od-estimate-shares">수량 <b data-testid="order-estimate-quantity">{formatQuantity(shares)}</b></span>}
    </div>
  );
}
