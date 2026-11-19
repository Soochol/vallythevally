import { useId } from "react";
import { formatQuantity, formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import type { QuantityMode } from "./orderRules";
import { AMOUNT_UNIT_WON } from "./orderSettings";

const MODES = [{ value: "shares", label: "수량" }, { value: "amount", label: "금액" }] as const;

const presetLabel = (mode: QuantityMode, value: number): string => (mode === "shares" ? String(value) : `${value / 10_000}만`);

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
  const shown = mode === "amount" && input !== "" ? formatQuantity(Number(input)) : input;
  const presets = mode === "shares" ? sharePresets : amountPresets.map((man) => man * AMOUNT_UNIT_WON);
  return (
    <div className="od-qty" data-mode={mode} data-testid="order-quantity-row">
      <label className="od-qty-label" htmlFor={inputId}>{label}</label>
      <input id={inputId} className="od-qty-input" inputMode="numeric" autoComplete="off" value={shown} onChange={(e) => onInput(e.target.value.replace(/[^0-9]/g, ""))} />
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
      예상 주문금액 <b data-testid="order-estimate">{estimate === null ? "-" : formatWon(estimate)}</b>
      {shares !== null && <> · 수량 <b data-testid="order-estimate-quantity">{formatQuantity(shares)}</b></>}
    </div>
  );
}
