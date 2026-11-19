import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../lib/format";
import { formatStrength } from "./format";
import type { LadderTrades } from "./useLadderSlots";
import { priceTone } from "./PriceLadder";
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

export const scrollAction = (scrollTop: number): "hold" | "release" => (scrollTop > 0 ? "hold" : "release");

function TradeBox({ trades, strength, hold, release, previousClose }: LadderTrades & { previousClose: number | null }) {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => () => {
    if (heldRef.current) releaseRef.current();
  }, []);
  const onScroll = (scrollTop: number) => {
    const action = scrollAction(scrollTop);
    if ((action === "hold") === heldRef.current) return;
    heldRef.current = action === "hold";
    setHeld(heldRef.current);
    (action === "hold" ? hold : release)();
  };
  return (
    <div className="mw-tbox">
      <div className="mw-slot mw-strength" data-testid="ladder-strength">체결강도 <b>{formatStrength(strength)}</b></div>
      <div className="mw-tscroll" data-testid="ladder-trades" data-held={held ? "" : undefined} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
        {trades.map((row) => (
          <div key={row.key} className="mw-slot mw-trade" data-testid="ladder-trade" data-side={row.side} data-price={row.price}>
            <span className="mw-trade-price" data-tone={priceTone(row.price, previousClose)}>{formatPrice(row.price, false)}</span>
            <span className="mw-trade-qty">{formatPrice(row.quantity, false)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const tradeSlot = (ladderTrades: LadderTrades, previousClose: number | null) => (): ReactNode => (
  <TradeBox {...ladderTrades} previousClose={previousClose} />
);
