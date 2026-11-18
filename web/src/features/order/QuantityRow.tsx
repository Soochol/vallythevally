import { useId } from "react";
import type { Venue } from "../../api/generated/Venue";
import { formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import type { QuantityMode } from "./orderRules";
import { AMOUNT_UNIT_WON } from "./orderSettings";
import { MOCK_KRX_ONLY_TEXT } from "./statusText";

const MODES = [{ value: "shares", label: "주" }, { value: "amount", label: "금액" }] as const;
const ROUTES = [{ value: "combined", label: "SOR" }, { value: "krx", label: "KRX" }, { value: "nxt", label: "NXT" }] as const;

const MOCK_DISABLED_ROUTES: readonly Venue[] = ["combined", "nxt"];

const presetLabel = (mode: QuantityMode, value: number): string => (mode === "shares" ? String(value) : `${value / 10_000}만`);

interface Props {
  readonly mode: QuantityMode;
  readonly input: string;
  readonly estimate: number | null;
  readonly venue: Venue;
  readonly mock: boolean;
  readonly sharePresets: readonly number[];
  readonly amountPresets: readonly number[];
  readonly onMode: (mode: QuantityMode) => void;
  readonly onInput: (input: string) => void;
  readonly onVenue: (venue: Venue) => void;
}

export function QuantityRow({ mode, input, estimate, venue, mock, sharePresets, amountPresets, onMode, onInput, onVenue }: Props) {
  const inputId = useId();
  const presets = mode === "shares" ? sharePresets : amountPresets.map((man) => man * AMOUNT_UNIT_WON);
  return (
    <div className="od-qty" data-testid="order-quantity-row">
      <div className="od-qty-line">
        <label className="od-qty-label" htmlFor={inputId}>수량</label>
        <input id={inputId} className="od-qty-input" inputMode="numeric" autoComplete="off" value={input} onChange={(e) => onInput(e.target.value.replace(/[^0-9]/g, ""))} />
        <Segmented label="수량 방식" options={MODES} value={mode} onChange={onMode} />
      </div>
      <div className="od-qty-line">
        <div className="od-presets" role="group" aria-label="수량 프리셋">
          {presets.map((value) => <button key={value} type="button" className="od-preset" onClick={() => onInput(String(value))}>{presetLabel(mode, value)}</button>)}
        </div>
        <Segmented label="주문 경로" options={ROUTES} value={venue} disabled={mock ? MOCK_DISABLED_ROUTES : undefined} onChange={onVenue} />
      </div>
      {mock && <p className="od-route-note" data-testid="order-route-note">{MOCK_KRX_ONLY_TEXT}</p>}
      <div className="od-estimate">예상 주문금액 <b data-testid="order-estimate">{estimate === null ? "-" : formatWon(estimate)}</b></div>
    </div>
  );
}
