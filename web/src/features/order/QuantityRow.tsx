import { type ChangeEvent, type KeyboardEvent, memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ALL_SELLING_TEXT } from "./holdingSummary";
import { type BuyingPower, maxBuyQuantity, quantityForAmount, quantityForRatio, RATIO_PRESETS } from "./orderRules";
import { AMOUNT_UNIT_WON, PRESET_MODES, type PresetMode } from "./orderSettings";

const NO_REFERENCE_PRICE_TEXT = "현재가를 아직 받지 못했습니다";
const NO_BUYING_POWER_TEXT = "주문가능 금액을 받지 못했습니다";
const NO_BUYABLE_QUANTITY_TEXT = "살 수 있는 수량이 없습니다";
const NO_HOLDING_TEXT = "보유 중인 종목이 아닙니다";

const PRESET_GROUP_LABEL: Readonly<Record<PresetMode, string>> = {
  amount: "금액 프리셋",
  buy: "매수 비율 프리셋",
  sell: "매도 비율 프리셋",
};

interface Props {
  readonly input: string;
  readonly mode: PresetMode;
  readonly amountPresets: readonly number[];
  readonly referencePrice: number | null;
  readonly buying: BuyingPower | null;
  readonly sellableRemaining: number | null;
  readonly hasHolding: boolean;
  readonly onMode: (mode: PresetMode) => void;
  readonly onInput: (input: string) => void;
  readonly onPreset: (input: string, buyFull: boolean) => void;
  readonly trailing?: ReactNode;
}

interface PresetButton {
  readonly key: string;
  readonly label: string;
  readonly quantity: number;
  readonly disabled: boolean;
  readonly title: string | undefined;
}

function buildAmountButtons(amountPresets: readonly number[], referencePrice: number | null): PresetButton[] {
  const noPrice = referencePrice === null || !(referencePrice > 0);
  return amountPresets.map((man) => ({
    key: `amount:${man}`,
    label: `${man.toLocaleString("ko-KR")}만`,
    quantity: quantityForAmount(man * AMOUNT_UNIT_WON, referencePrice) ?? 0,
    disabled: noPrice,
    title: noPrice ? NO_REFERENCE_PRICE_TEXT : undefined,
  }));
}

function buildBuyRatioButtons(referencePrice: number | null, buying: BuyingPower | null): PresetButton[] {
  const noPrice = referencePrice === null || !(referencePrice > 0);
  const maxQuantity = !noPrice && buying !== null ? maxBuyQuantity(referencePrice, buying.amount) : null;
  const policyText = buying?.policy === "allow_margin" ? "미수 포함" : "현금";
  return RATIO_PRESETS.map(({ percent, label }) => {
    const quantity = maxQuantity === null ? 0 : quantityForRatio(maxQuantity, percent);
    const title = noPrice
      ? NO_REFERENCE_PRICE_TEXT
      : buying === null
        ? NO_BUYING_POWER_TEXT
        : maxQuantity === 0
          ? NO_BUYABLE_QUANTITY_TEXT
          : quantity === 0
            ? `${label} 계산 결과가 1주 미만입니다`
            : `${policyText} 매수가능 ${label} · ${quantity.toLocaleString("ko-KR")}주`;
    return { key: `buy:${percent}`, label, quantity, disabled: quantity <= 0, title };
  });
}

function buildSellRatioButtons(sellableRemaining: number | null, hasHolding: boolean): PresetButton[] {
  const available = sellableRemaining !== null && sellableRemaining > 0 ? sellableRemaining : 0;
  return RATIO_PRESETS.map(({ percent, label }) => {
    const quantity = available > 0 ? quantityForRatio(available, percent) : 0;
    const title = !hasHolding
      ? NO_HOLDING_TEXT
      : available <= 0
        ? ALL_SELLING_TEXT
        : quantity === 0
          ? `${label} 계산 결과가 1주 미만입니다`
          : `매도가능 ${available.toLocaleString("ko-KR")}주의 ${label} · ${quantity.toLocaleString("ko-KR")}주`;
    return { key: `sell:${percent}`, label, quantity, disabled: quantity <= 0, title };
  });
}

export const QuantityRow = memo(function QuantityRow({ input, mode, amountPresets, referencePrice, buying, sellableRemaining, hasHolding, onMode, onInput, onPreset, trailing }: Props) {
  const field = useRef<HTMLInputElement>(null);
  const digitsBeforeCaret = useRef<number | null>(null);
  const [picked, setPicked] = useState<{ readonly mode: PresetMode; readonly key: string; readonly value: string } | null>(null);
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
    setPicked(null);
    onInput(digits);
  };
  const nudge = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1);
    setPicked(null);
    onInput(String(Math.max(0, (Number(input) || 0) + step)));
  };
  const buttons = mode === "amount"
    ? buildAmountButtons(amountPresets, referencePrice)
    : mode === "buy"
      ? buildBuyRatioButtons(referencePrice, buying)
      : buildSellRatioButtons(sellableRemaining, hasHolding);
  const pickPreset = (button: PresetButton) => {
    const nextValue = String(button.quantity);
    setPicked({ mode, key: button.key, value: nextValue });
    onPreset(nextValue, button.key === "buy:100");
  };
  return (
    <div className="od-qty" data-testid="order-quantity-row" data-preset-mode={mode}>
      <input ref={field} className="od-qty-input" aria-label="수량" inputMode="numeric" autoComplete="off" value={input} onChange={change} onKeyDown={nudge} />
      <div className="mw-seg od-preset-mode" role="group" aria-label="프리셋 기준">
        {PRESET_MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            data-mode={option.value}
            aria-pressed={mode === option.value}
            onClick={() => {
              setPicked(null);
              onMode(option.value);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="od-presets" role="group" aria-label={PRESET_GROUP_LABEL[mode]}>
        {buttons.map((button) => (
          <button
            key={button.key}
            type="button"
            className="od-preset"
            data-side-tone={mode === "amount" ? undefined : mode}
            data-picked={picked !== null && picked.mode === mode && picked.key === button.key && picked.value === input ? "" : undefined}
            disabled={button.disabled}
            title={button.title}
            onClick={() => pickPreset(button)}
          >
            {button.label}
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
});
