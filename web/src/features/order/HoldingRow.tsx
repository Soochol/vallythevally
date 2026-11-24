import { memo } from "react";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { formatPrice } from "../../lib/format";
import { useWatchQuote } from "../../stores/watchQuote";
import { formatQuantity } from "../market-window/format";
import { atWatchQuote, profitText, profitTone } from "./holdingSummary";
import { type GoToSymbol, SymbolName } from "./SymbolName";

const HoldingRowView = memo(function HoldingRowView({ holding, goTo }: { holding: TradingHolding; goTo: GoToSymbol }) {
  return (
    <li data-testid="account-holding">
      <SymbolName code={holding.code} name={holding.name} goTo={goTo} />
      <span className="od-figure">{formatQuantity(holding.quantity)}</span>
      <span className="od-figure">{formatPrice(holding.averagePrice, false)}</span>
      <b className="od-figure" data-tone={profitTone(holding.evaluationProfit)}>{profitText(holding, "won")}</b>
    </li>
  );
});

const WatchedHoldingRow = memo(function WatchedHoldingRow({ holding, goTo }: { holding: TradingHolding; goTo: GoToSymbol }) {
  const watch = useWatchQuote(holding.code);
  return <HoldingRowView holding={atWatchQuote(holding, watch)} goTo={goTo} />;
});

export const HoldingRow = memo(function HoldingRow({ holding, fixed, goTo }: { holding: TradingHolding; fixed: TradingHolding | null; goTo: GoToSymbol }) {
  if (fixed !== null) return <HoldingRowView holding={fixed} goTo={goTo} />;
  return <WatchedHoldingRow holding={holding} goTo={goTo} />;
});
