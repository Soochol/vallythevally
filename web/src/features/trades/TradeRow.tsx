import { direction, formatPrice } from "../../lib/format";
import { formatSecond, isBigTrade, type TradeRow as TradeRowData } from "./tape";

function priceColor(row: TradeRowData, previousClose: number | null): "up" | "down" | "flat" {
  if (previousClose !== null && previousClose > 0) return direction(row.price - previousClose);
  return row.side === "buy" ? "up" : row.side === "sell" ? "down" : "flat";
}

export function TradeRow({ row, previousClose, fresh }: { row: TradeRowData; previousClose: number | null; fresh?: boolean }) {
  const big = isBigTrade(row);
  return (
    <div role="row" className="tr-row" data-testid="trade-row" data-side={row.side} data-big={big ? "" : undefined} data-fresh={fresh ? "" : undefined} data-price={row.price}>
      <span role="cell" className="tr-time">{formatSecond(row.secondOfDay)}</span>
      <span role="cell" className="tr-price" data-dir={priceColor(row, previousClose)}>{formatPrice(row.price, false)}</span>
      <span role="cell" className="tr-qty">{formatPrice(row.quantity, false)}</span>
    </div>
  );
}
