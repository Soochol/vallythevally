import { type ChangeEvent, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { quantityForAmount } from "./orderRules";
import { AMOUNT_UNIT_WON } from "./orderSettings";

const NO_REFERENCE_PRICE_TEXT = "현재가를 아직 받지 못했습니다";

interface Props {
  readonly input: string;
  readonly amountPresets: readonly number[];
  readonly referencePrice: number | null;
  readonly onInput: (input: string) => void;
  readonly trailing?: ReactNode;
}

export function QuantityRow({ input, amountPresets, referencePrice, onInput, trailing }: Props) {
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
  const nudge = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1);
    onInput(String(Math.max(0, (Number(input) || 0) + step)));
  };
  const noPrice = referencePrice === null || !(referencePrice > 0);
  const fillAmount = (won: number) => onInput(String(quantityForAmount(won, referencePrice) ?? 0));
  return (
    <div className="od-qty" data-testid="order-quantity-row">
      <input ref={field} className="od-qty-input" aria-label="수량" inputMode="numeric" autoComplete="off" value={input} onChange={change} onKeyDown={nudge} />
      <div className="od-presets" role="group" aria-label="금액 프리셋">
        {amountPresets.map((man) => <button key={man} type="button" className="od-preset" disabled={noPrice} title={noPrice ? NO_REFERENCE_PRICE_TEXT : undefined} onClick={() => fillAmount(man * AMOUNT_UNIT_WON)}>{`${man.toLocaleString("ko-KR")}만`}</button>)}
      </div>
      {trailing}
    </div>
  );
}
