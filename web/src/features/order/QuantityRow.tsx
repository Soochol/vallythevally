import type { Venue } from "../../api/generated/Venue";
import { formatWon } from "../market-window/format";
import { Segmented } from "../market-window/parts";
import type { QuantityMode } from "./orderRules";

const AMOUNT_PRESETS = [1_000_000, 5_000_000, 10_000_000, 50_000_000] as const;
const MODES = [{ value: "shares", label: "주" }, { value: "amount", label: "금액" }] as const;
const ROUTES = [{ value: "combined", label: "SOR" }, { value: "krx", label: "KRX" }, { value: "nxt", label: "NXT" }] as const;

const presetLabel = (mode: QuantityMode, value: number): string => (mode === "shares" ? String(value) : `${value / 10_000}만`);

interface Props {
  readonly mode: QuantityMode;
  readonly input: string;
  readonly estimate: number | null;
  readonly venue: Venue;
  readonly sharePresets: readonly number[];
  readonly onMode: (mode: QuantityMode) => void;
  readonly onInput: (input: string) => void;
  readonly onVenue: (venue: Venue) => void;
}

export function QuantityRow({ mode, input, estimate, venue, sharePresets, onMode, onInput, onVenue }: Props) {
  const presets = mode === "shares" ? sharePresets : AMOUNT_PRESETS;
  return (
    <div className="od-qty" data-testid="order-quantity-row">
      <div className="od-qty-line">
        <label className="od-qty-label" htmlFor="order-quantity">수량</label>
        <input id="order-quantity" className="od-qty-input" inputMode="numeric" autoComplete="off" value={input} onChange={(e) => onInput(e.target.value.replace(/[^0-9]/g, ""))} />
        <Segmented label="수량 방식" options={MODES} value={mode} onChange={onMode} />
      </div>
      <div className="od-qty-line">
        <div className="od-presets" role="group" aria-label="수량 프리셋">
          {presets.map((value) => <button key={value} type="button" className="od-preset" onClick={() => onInput(String(value))}>{presetLabel(mode, value)}</button>)}
        </div>
        <Segmented label="주문 경로" options={ROUTES} value={venue} onChange={onVenue} />
      </div>
      <div className="od-estimate">예상 주문금액 <b data-testid="order-estimate">{estimate === null ? "-" : formatWon(estimate)}</b></div>
    </div>
  );
}
