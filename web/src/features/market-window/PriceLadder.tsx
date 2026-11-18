import type { ReactNode } from "react";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { formatShares, withSign } from "./format";
import { type BookLevel, LADDER_ROWS, type LadderRow, ROWS_ABOVE_BASE } from "./ladder";

export const TOP_RIGHT_ROWS = 7;
export const BOTTOM_LEFT_ROWS = 8;

export interface LadderSlots {
  readonly left?: (row: LadderRow) => ReactNode;
  readonly right?: (row: LadderRow) => ReactNode;
}

export interface LadderRowSlots {
  readonly topRight?: (slot: number) => ReactNode;
  readonly bottomLeft?: (slot: number) => ReactNode;
}

export interface LadderMark {
  readonly price: number | null;
  readonly label: string;
}

interface Props {
  readonly rows: readonly LadderRow[];
  readonly previousClose: number | null;
  readonly slots?: LadderSlots;
  readonly rowSlots?: LadderRowSlots;
  readonly mark?: LadderMark;
}

const TONE = { up: "mw-up", down: "mw-down", flat: "" } as const;

function Quantity({ side, level, ratio }: { side: "ask" | "bid"; level: BookLevel; ratio: number }) {
  const flash = level.change === 0 ? undefined : level.change > 0 ? "up" : "down";
  const value = <span key="value" className="mw-qty-value">{formatShares(level.quantity)}</span>;
  const change = flash && <span key={`${level.quantity}:${level.change}`} className="mw-qty-change" data-flash={flash}>{withSign(level.change, formatShares(Math.abs(level.change)))}</span>;
  return (
    <div className="mw-qty" data-side={side}>
      <i className="mw-qty-bar" style={{ width: `${ratio * 100}%` }}>
        {flash && <b key={`${level.quantity}:${level.change}`} className="mw-qty-glow" data-flash={flash} />}
      </i>
      {side === "ask" ? [change, value] : [value, change]}
    </div>
  );
}

function Price({ row, previousClose, mark }: { row: LadderRow; previousClose: number | null; mark: LadderMark | undefined }) {
  if (row.price === null) return <div className="mw-px" />;
  const tone = previousClose === null || !(previousClose > 0) ? "flat" : direction(row.price - previousClose);
  return (
    <div className={`mw-px ${TONE[tone]}`}>
      <span className="mw-px-num">
        {mark?.price === row.price && <i className="mw-px-mark" data-testid="ladder-mark" title={mark.label} />}
        {formatPrice(row.price, false)}
      </span>
      {row.rate !== null && <small>{formatPercent(row.rate)}</small>}
    </div>
  );
}

export function PriceLadder({ rows, previousClose, slots, rowSlots, mark }: Props) {
  const columns = `${slots?.left ? "var(--size-64) " : ""}minmax(0, 1fr) var(--size-120) minmax(0, 1fr)${slots?.right ? " var(--size-64)" : ""}`;
  const firstBottomLeft = LADDER_ROWS - BOTTOM_LEFT_ROWS;
  return (
    <div className="mw-ladder" data-testid="price-ladder">
      {rows.map((row, index) => (
        <div key={row.key} className="mw-lr" data-side={index < ROWS_ABOVE_BASE ? "ask" : "bid"} data-current={row.current ? "" : undefined} data-empty={row.price === null ? "" : undefined} style={{ gridTemplateColumns: columns }}>
          {slots?.left?.(row)}
          {row.ask ? <Quantity side="ask" level={row.ask} ratio={row.askRatio} /> : <div className="mw-qty" data-side="ask">{index >= firstBottomLeft && rowSlots?.bottomLeft?.(index - firstBottomLeft)}</div>}
          <Price row={row} previousClose={previousClose} mark={mark} />
          {row.bid ? <Quantity side="bid" level={row.bid} ratio={row.bidRatio} /> : <div className="mw-qty" data-side="bid">{index < TOP_RIGHT_ROWS && rowSlots?.topRight?.(index)}</div>}
          {slots?.right?.(row)}
        </div>
      ))}
    </div>
  );
}
