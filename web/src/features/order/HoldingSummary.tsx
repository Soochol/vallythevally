import { useRef, useState } from "react";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { formatPrice } from "../../lib/format";
import { formatQuantity, formatWon } from "../market-window/format";
import { FundsPopover } from "./FundsPopover";
import { buyableName } from "./funds";
import { costTitle, type ProfitUnit, profitText, sellableFill } from "./holdingSummary";

interface Props {
  readonly holding: TradingHolding | null;
  readonly orderable: TradingOrderable | null;
  readonly buyableProblem: string | null;
  readonly unit: ProfitUnit;
  readonly onUnit: () => void;
  readonly onFill: (input: string) => void;
}

export function HoldingSummary({ holding, orderable, buyableProblem, unit, onUnit, onFill }: Props) {
  const fill = sellableFill(holding);
  const [funds, setFunds] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const policy = orderable?.policy ?? null;
  const tone = holding === null ? undefined : holding.evaluationProfit > 0 ? "up" : holding.evaluationProfit < 0 ? "down" : undefined;
  return (
    <div className="od-summary" data-testid="order-summary">
      <button type="button" className="od-cellbtn" data-testid="summary-quantity" disabled={fill === null} title={costTitle(holding)} onClick={() => fill && onFill(fill)}>
        <small>매입수량</small><b>{holding === null ? "-" : formatQuantity(holding.quantity)}</b>
      </button>
      <div className="od-cellbtn" data-testid="summary-average"><small>매입평단가</small><b>{holding === null ? "-" : formatPrice(holding.averagePrice, false)}</b></div>
      <button type="button" className="od-cellbtn" data-testid="summary-profit" data-tone={tone} title="원과 % 사이를 바꿉니다" onClick={onUnit}>
        <small>평가손익</small><b>{profitText(holding, unit)}</b>
      </button>
      <button type="button" ref={opener} className="od-cellbtn" data-testid="summary-buyable" data-policy={policy ?? undefined} data-unpaid={orderable !== null && orderable.unpaid > 0 ? orderable.unpaid : undefined} aria-expanded={funds} disabled={orderable === null} title={buyableProblem ?? undefined} onClick={() => setFunds((open) => !open)}>
        <small>{buyableName(policy)}{orderable !== null && orderable.unpaid > 0 && <i className="od-unpaid-dot" aria-label="미수금 있음" />}</small>
        <b>{orderable === null ? "-" : formatWon(orderable.amount)}</b>
      </button>
      {funds && orderable !== null && <FundsPopover orderable={orderable} opener={opener} onClose={() => setFunds(false)} />}
    </div>
  );
}
