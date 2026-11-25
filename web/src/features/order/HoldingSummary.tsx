import { memo, useRef, useState } from "react";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { formatPrice } from "../../lib/format";
import { formatQuantity, formatWon } from "../market-window/format";
import { FundsPopover } from "./FundsPopover";
import { buyableName } from "./funds";
import { ALL_SELLING_TEXT, costTitle, type ProfitUnit, profitDisplay, remainingToSell, sellableFill } from "./holdingSummary";

interface Props {
  readonly account: string | null;
  readonly holding: TradingHolding | null;
  readonly orderable: TradingOrderable | null;
  readonly buyableProblem: string | null;
  readonly sellOrdered: number;
  readonly unit: ProfitUnit;
  readonly onUnit: () => void;
  readonly onFill: (input: string) => void;
}

export const HoldingSummary = memo(function HoldingSummary({ account, holding, orderable, buyableProblem, sellOrdered, unit, onUnit, onFill }: Props) {
  const fill = sellableFill(holding, sellOrdered);
  const allSelling = holding !== null && sellOrdered > 0 && fill === null;
  const [funds, setFunds] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const policy = orderable?.policy ?? null;
  const tone = holding === null ? undefined : holding.evaluationProfit > 0 ? "up" : holding.evaluationProfit < 0 ? "down" : undefined;
  const profit = profitDisplay(holding, unit);
  return (
    <div className="od-summary" data-testid="order-summary">
      <button type="button" className="od-cellbtn" data-testid="summary-quantity" disabled={fill === null} title={allSelling ? ALL_SELLING_TEXT : costTitle(holding)} onClick={() => fill && onFill(fill)}>
        <small><span>매입수량</span>{holding !== null && sellOrdered > 0 && <i className="od-remaining" data-testid="summary-remaining">남은 {formatQuantity(Math.max(0, remainingToSell(holding, sellOrdered)))}</i>}</small><b>{holding === null ? "-" : formatQuantity(holding.quantity)}</b>
      </button>
      <div className="od-cellbtn" data-testid="summary-average"><small>매입평단가</small><b title={holding === null ? undefined : formatPrice(holding.averagePrice, false)}>{holding === null ? "-" : formatPrice(holding.averagePrice, false)}</b></div>
      <button type="button" className="od-cellbtn" data-testid="summary-profit" data-tone={tone} title="원과 % 사이를 바꿉니다" onClick={onUnit}>
        <small><span>평가손익</span></small>
        <b className="od-profit-value" data-alt={profit.alternate} title={profit.current}><span>{profit.current}</span></b>
      </button>
      <button type="button" ref={opener} className="od-cellbtn" data-testid="summary-buyable" data-policy={policy ?? undefined} data-unpaid={orderable !== null && orderable.unpaid > 0 ? orderable.unpaid : undefined} aria-expanded={funds} disabled={orderable === null} title={buyableProblem ?? undefined} onClick={() => setFunds((open) => !open)}>
        <small><span>{buyableName(policy)}</span>{orderable !== null && orderable.unpaid > 0 && <i className="od-unpaid-dot" aria-label="미수금 있음" />}</small>
        <b title={orderable === null ? undefined : formatWon(orderable.amount)}>{orderable === null ? "-" : formatWon(orderable.amount)}</b>
      </button>
      {funds && orderable !== null && <FundsPopover account={account} orderable={orderable} opener={opener} onClose={() => setFunds(false)} />}
    </div>
  );
});
