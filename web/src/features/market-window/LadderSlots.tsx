import type { ReactNode } from "react";
import { direction, formatPrice } from "../../lib/format";
import { type TradeRow } from "../trades/tape";
import { formatStrength } from "./format";
import type { LadderTrades } from "./useLadderSlots";
import type { QuoteInfo } from "./quoteInfo";

export const infoSlot = (items: readonly (QuoteInfo | null)[]) => (slot: number): ReactNode => {
  const item = items[slot];
  if (!item) return null;
  return (
    <div className="mw-slot mw-info" data-testid="ladder-info" data-label={item.label}>
      <span>{item.label}</span>
      <b data-tone={item.tone ?? undefined}>{item.value}</b>
    </div>
  );
};

function priceTone(row: TradeRow, previousClose: number | null): "up" | "down" | "flat" {
  if (previousClose !== null && previousClose > 0) return direction(row.price - previousClose);
  return row.side === "buy" ? "up" : row.side === "sell" ? "down" : "flat";
}

export const tradeSlot = ({ strength, trades }: LadderTrades, previousClose: number | null) => (slot: number): ReactNode => {
  if (slot === 0) return <div className="mw-slot mw-strength" data-testid="ladder-strength">체결강도 <b>{formatStrength(strength)}</b></div>;
  const row = trades[slot - 1];
  if (!row) return null;
  return (
    <div className="mw-slot mw-trade" data-testid="ladder-trade" data-side={row.side} data-price={row.price}>
      <span className="mw-trade-price" data-tone={priceTone(row, previousClose)}>{formatPrice(row.price, false)}</span>
      <span className="mw-trade-qty">{formatPrice(row.quantity, false)}</span>
    </div>
  );
};
