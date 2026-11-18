import type { ReactNode } from "react";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { formatShares, withSign } from "./format";
import type { LadderRow } from "./ladder";

export interface LadderSlots {
  readonly left?: (row: LadderRow) => ReactNode;
  readonly right?: (row: LadderRow) => ReactNode;
}

const TONE = { up: "mw-up", down: "mw-down", flat: "" } as const;

function Quantity({ row }: { row: LadderRow }) {
  const level = row.level;
  const flash = level && level.change !== 0 ? (level.change > 0 ? "up" : "down") : undefined;
  return (
    <div className="mw-qty" data-side={row.side}>
      {level && <i className="mw-qty-bar" style={{ width: `${row.barRatio * 100}%` }} />}
      {level && <span key={level.quantity} className="mw-qty-value" data-flash={flash}>{formatShares(level.quantity)}</span>}
      {level && flash && <span key={`${level.quantity}:${level.change}`} className="mw-qty-delta" data-flash={flash}>{withSign(level.change, formatShares(Math.abs(level.change)))}</span>}
    </div>
  );
}

function Price({ row, previousClose }: { row: LadderRow; previousClose: number | null }) {
  if (!row.level) return <div className="mw-px" />;
  const tone = previousClose === null || !(previousClose > 0) ? "flat" : direction(row.level.price - previousClose);
  return (
    <div className={`mw-px ${TONE[tone]}`}>
      {formatPrice(row.level.price, false)}
      {row.current && row.rate !== null && <small>{formatPercent(row.rate)}</small>}
    </div>
  );
}

export function PriceLadder({ rows, previousClose, slots }: { rows: readonly LadderRow[]; previousClose: number | null; slots?: LadderSlots }) {
  const columns = `${slots?.left ? "auto " : ""}1fr var(--size-84) 1fr${slots?.right ? " auto" : ""}`;
  return (
    <div className="mw-ladder" data-testid="price-ladder">
      {rows.map((row) => (
        <div key={row.key} className="mw-lr" data-side={row.side} data-current={row.current ? "" : undefined} data-empty={row.level ? undefined : ""} style={{ gridTemplateColumns: columns }}>
          {slots?.left?.(row)}
          {row.side === "ask" ? <Quantity row={row} /> : <div />}
          <Price row={row} previousClose={previousClose} />
          {row.side === "bid" ? <Quantity row={row} /> : <div />}
          {slots?.right?.(row)}
        </div>
      ))}
    </div>
  );
}
