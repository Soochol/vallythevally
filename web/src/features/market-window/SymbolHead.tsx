import { memo } from "react";
import { formatPrice } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { priceTone } from "./PriceLadder";

interface Props {
  readonly code: string;
  readonly name: string | null;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly marketOpen: boolean;
  readonly mock: boolean;
  readonly testIdPrefix?: string;
}

const ARROW = { up: "▲", down: "▼", flat: "" } as const;

export const SymbolHead = memo(function SymbolHead({ code, name, lastPrice, previousClose, marketOpen, mock, testIdPrefix = "order-symbol" }: Props) {
  const tone = lastPrice === null ? "flat" : priceTone(lastPrice, previousClose);
  const rate = lastPrice !== null && previousClose !== null && previousClose > 0 ? ((lastPrice - previousClose) / previousClose) * 100 : null;
  return (
    <div className="od-head" data-testid={`${testIdPrefix}-head`} data-mock={mock ? "" : undefined}>
      <b className="od-head-name" data-testid={`${testIdPrefix}-name`} title={name ?? undefined}>{name ?? code}</b>
      <span className="od-head-code" data-testid={`${testIdPrefix}-code`}>{code}</span>
      <span className="od-head-price" data-testid={`${testIdPrefix}-price`} data-tone={tone}>{lastPrice === null ? "-" : formatPrice(lastPrice, false)}</span>
      {rate !== null && <span className="od-head-rate" data-tone={tone}>{ARROW[tone]}{Math.abs(rate).toFixed(2)}%</span>}
      <Badge tone={marketOpen ? "success" : "neutral"} className="od-head-market">{marketOpen ? "장중" : "장 마감"}</Badge>
    </div>
  );
});
