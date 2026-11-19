import type { TradingHolding } from "../../api/generated/TradingHolding";
import { formatPrice } from "../../lib/format";
import { formatQuantity, formatWon } from "../market-window/format";
import { costTitle, type ProfitUnit, profitText, sellableFill, type QuantityFill } from "./holdingSummary";

interface Props {
  readonly holding: TradingHolding | null;
  readonly buyableAmount: number | null;
  readonly buyableProblem: string | null;
  readonly unit: ProfitUnit;
  readonly onUnit: () => void;
  readonly onFill: (fill: QuantityFill) => void;
}

export function HoldingSummary({ holding, buyableAmount, buyableProblem, unit, onUnit, onFill }: Props) {
  const fill = sellableFill(holding);
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
      <div className="od-cellbtn" data-testid="summary-buyable" title={buyableProblem ?? undefined}><small>매수 가능</small><b>{buyableAmount === null ? "-" : formatWon(buyableAmount)}</b></div>
    </div>
  );
}
