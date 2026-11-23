import { isValidElement, memo, type ReactNode, useLayoutEffect, useRef } from "react";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { formatQuantity, withSign } from "./format";
import { type BookLevel, type LadderRow, ROWS_ABOVE_BASE } from "./ladder";
import { replayChangeFade, replayGlow } from "./flash";
import { infoCardRows } from "./quoteInfo";

export interface LadderSlots {
  readonly left?: (row: LadderRow) => ReactNode;
  readonly right?: (row: LadderRow) => ReactNode;
}

export interface LadderRowSlots {
  readonly infoCard?: (rowCount: number) => ReactNode;
  readonly bottomLeft?: (rowCount: number) => ReactNode;
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
  readonly expectedPrice?: number | null;
  readonly firstBidIndex?: number;
}

const TONE = { up: "mw-up", down: "mw-down", flat: "" } as const;

type Flash = "up" | "down";

const flashOf = (change: number): Flash | undefined => (change === 0 ? undefined : change > 0 ? "up" : "down");

const Quantity = memo(function Quantity({ side, quantity, change, ratio }: { side: "ask" | "bid"; quantity: number; change: number; ratio: number }) {
  const flash = flashOf(change);
  const changeText = useRef<HTMLSpanElement>(null);
  const glow = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (flash === undefined) return;
    replayChangeFade(changeText.current);
    replayGlow(glow.current);
  }, [quantity, change]);
  const value = <span key="value" className="mw-qty-value">{formatQuantity(quantity)}</span>;
  const changed = flash && <span key="change" ref={changeText} className="mw-qty-change" data-flash={flash}>{withSign(change, formatQuantity(Math.abs(change)))}</span>;
  return (
    <div className="mw-qty" data-side={side}>
      <i className="mw-qty-bar" style={{ transform: `scaleX(${ratio})` }}>
        {flash && <b ref={glow} className="mw-qty-glow" data-flash={flash} />}
      </i>
      {side === "ask" ? [changed, value] : [value, changed]}
    </div>
  );
});

export const priceTone = (price: number, previousClose: number | null): "up" | "down" | "flat" =>
  previousClose === null || !(previousClose > 0) ? "flat" : direction(price - previousClose);

export function tradeBoxStart(rows: readonly LadderRow[]): number {
  let start = ROWS_ABOVE_BASE;
  rows.forEach((row, index) => {
    if (index >= start && row.ask) start = index + 1;
  });
  return start;
}

const sameLevel = (a: BookLevel | null, b: BookLevel | null): boolean => a === b || (a !== null && b !== null && a.quantity === b.quantity && a.change === b.change);

const sameRow = (a: LadderRow, b: LadderRow): boolean =>
  a === b || (a.key === b.key && a.price === b.price && a.rate === b.rate && a.current === b.current && a.repeat === b.repeat && a.askRatio === b.askRatio && a.bidRatio === b.bidRatio && sameLevel(a.ask, b.ask) && sameLevel(a.bid, b.bid));

const sameProps = (a: object, b: object): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};

const sameNode = (a: ReactNode, b: ReactNode): boolean =>
  Object.is(a, b) || (isValidElement(a) && isValidElement(b) && a.type === b.type && a.key === b.key && sameProps(a.props as object, b.props as object));

function Price({ row, previousClose, markTitle }: { row: LadderRow; previousClose: number | null; markTitle: string | null }) {
  if (row.price === null) return <div className="mw-px" />;
  const tone = priceTone(row.price, previousClose);
  return (
    <div className={`mw-px ${TONE[tone]}`}>
      <span className="mw-px-num">
        {markTitle !== null && <i className="mw-px-mark" data-testid="ladder-mark" title={markTitle} />}
        {formatPrice(row.price, false)}
      </span>
      {row.rate !== null && <small>{formatPercent(row.rate)}</small>}
    </div>
  );
}

interface LineProps {
  readonly row: LadderRow;
  readonly side: "ask" | "bid";
  readonly columns: string;
  readonly previousClose: number | null;
  readonly markTitle: string | null;
  readonly expected: boolean;
  readonly left: ReactNode;
  readonly right: ReactNode;
}

const sameLine = (a: LineProps, b: LineProps): boolean =>
  sameRow(a.row, b.row) && a.side === b.side && a.columns === b.columns && a.previousClose === b.previousClose && a.markTitle === b.markTitle && a.expected === b.expected && sameNode(a.left, b.left) && sameNode(a.right, b.right);

const LadderLine = memo(function LadderLine({ row, side, columns, previousClose, markTitle, expected, left, right }: LineProps) {
  return (
    <div className="mw-lr" data-side={side} data-current={row.current ? "" : undefined} data-expected={expected ? "" : undefined} data-empty={row.price === null ? "" : undefined} style={{ gridTemplateColumns: columns }}>
      {left}
      {row.ask ? <Quantity side="ask" quantity={row.ask.quantity} change={row.ask.change} ratio={row.askRatio} /> : <div className="mw-qty" data-side="ask" />}
      <Price row={row} previousClose={previousClose} markTitle={markTitle} />
      {row.bid ? <Quantity side="bid" quantity={row.bid.quantity} change={row.bid.change} ratio={row.bidRatio} /> : <div className="mw-qty" data-side="bid" />}
      {right}
    </div>
  );
}, sameLine);

export const ladderColumns = (hasLeft: boolean, hasRight: boolean): string =>
  `${hasLeft ? "var(--size-64) " : ""}minmax(0, 1fr) var(--size-133) minmax(0, 1fr)${hasRight ? " var(--size-64)" : ""}`;

export function PriceLadder({ rows, previousClose, slots, rowSlots, mark, expectedPrice = null, firstBidIndex = ROWS_ABOVE_BASE }: Props) {
  const columns = ladderColumns(slots?.left !== undefined, slots?.right !== undefined);
  const boxStart = tradeBoxStart(rows);
  const boxRows = rows.length - boxStart;
  const cardRows = infoCardRows(rows);
  return (
    <div className="mw-ladder" data-testid="price-ladder">
      {rows.map((row, index) => (
        <LadderLine key={row.key} row={row} side={index < firstBidIndex ? "ask" : "bid"} columns={columns} previousClose={previousClose}
          markTitle={mark !== undefined && mark.price === row.price && row.price !== null && !row.repeat ? mark.label : null}
          expected={expectedPrice !== null && row.price === expectedPrice && !row.repeat} left={slots?.left?.(row)} right={slots?.right?.(row)} />
      ))}
      {cardRows > 0 && rowSlots?.infoCard && (
        <div className="mw-info-layer" data-testid="ladder-info-layer" style={{ gridTemplateColumns: columns, top: "var(--s1)", height: `calc(${cardRows} * var(--size-24))` }}>
          <div className="mw-info-cell" style={{ gridColumn: slots?.left ? 4 : 3 }}>{rowSlots.infoCard(cardRows)}</div>
        </div>
      )}
      {boxRows > 0 && rowSlots?.bottomLeft && (
        <div className="mw-box-layer" data-testid="ladder-box-layer" style={{ gridTemplateColumns: columns, top: `calc(var(--s1) + ${boxStart} * var(--size-24))`, height: `calc(${boxRows} * var(--size-24))` }}>
          <div className="mw-box" style={slots?.left ? { gridColumn: 2 } : undefined}>{rowSlots.bottomLeft(boxRows)}</div>
        </div>
      )}
    </div>
  );
}
