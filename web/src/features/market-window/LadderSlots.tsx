import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../lib/format";
import { formatStrength } from "./format";
import type { InfoPager, LadderTrades } from "./useLadderSlots";
import { priceTone } from "./PriceLadder";
import type { TradeRow } from "../trades/tape";
import { INFO_TABS, type InfoLine, type InfoPage, otherInfoPage } from "./quoteInfo";

function InfoRow({ line }: { line: InfoLine }) {
  if (line.kind === "range") {
    return (
      <div className="mw-card-range" data-testid="ladder-info-range" data-label={line.label} role="img" aria-label={line.label}>
        <span className="mw-range-track">{line.position !== null && <i className="mw-range-tick" data-testid="ladder-info-tick" style={{ left: `${line.position * 100}%` }} />}</span>
      </div>
    );
  }
  if (line.kind === "ends") {
    return <div className="mw-card-ends" data-testid="ladder-info-ends"><span>{line.low}</span><span>{line.high}</span></div>;
  }
  const { item } = line;
  return (
    <div className="mw-card-row" data-testid="ladder-info" data-label={item.label} data-band={item.band ? item.tone : undefined} data-warn={item.tone === "warning" ? "" : undefined}>
      <span>{item.label}</span>
      <b data-tone={item.tone ?? undefined}>{item.value}</b>
    </div>
  );
}

function InfoTabs({ pager }: { pager: InfoPager }) {
  const refs = useRef<Partial<Record<InfoPage, HTMLButtonElement | null>>>({});
  const choose = (page: InfoPage) => {
    pager.select(page);
    refs.current[page]?.focus();
  };
  return (
    <div className="mw-card-dots" role="tablist" aria-label="상세 정보">
      {INFO_TABS.map(({ page, label }) => (
        <button key={page} ref={(node) => { refs.current[page] = node; }} type="button" role="tab" aria-label={label} title={label} aria-selected={pager.page === page} tabIndex={pager.page === page ? 0 : -1}
          onClick={() => pager.select(page)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            choose(otherInfoPage(page));
          }} />
      ))}
    </div>
  );
}

const sameLines = (a: readonly InfoLine[], b: readonly InfoLine[]): boolean =>
  a === b || (a.length === b.length && a.every((line, index) => JSON.stringify(line) === JSON.stringify(b[index])));

const InfoCard = memo(function InfoCard({ lines, rows, page, select }: { lines: readonly InfoLine[]; rows: number; page: InfoPage; select: InfoPager["select"] }) {
  return (
    <div className="mw-card" data-testid="ladder-info-card" style={{ height: `calc(${rows} * var(--size-24))` }}>
      {lines.map((line, index) => <InfoRow key={index} line={line} />)}
      <InfoTabs pager={{ page, select }} />
    </div>
  );
}, (a, b) => a.rows === b.rows && a.page === b.page && a.select === b.select && sameLines(a.lines, b.lines));

export const infoSlot = (lines: readonly InfoLine[], pager: InfoPager) => (rowCount: number): ReactNode => (
  <InfoCard lines={lines} rows={rowCount} page={pager.page} select={pager.select} />
);

export const scrollAction = (scrollTop: number): "hold" | "release" => (scrollTop > 0 ? "hold" : "release");

type TradeBoxProps = Pick<LadderTrades, "trades" | "strength" | "hold" | "release"> & { readonly previousClose: number | null };

const BoxTrade = memo(function BoxTrade({ row, previousClose }: { row: TradeRow; previousClose: number | null }) {
  return (
    <div className="mw-slot mw-trade" data-testid="ladder-trade" data-side={row.side} data-price={row.price}>
      <span className="mw-trade-price" data-tone={priceTone(row.price, previousClose)}>{formatPrice(row.price, false)}</span>
      <span className="mw-trade-qty">{formatPrice(row.quantity, false)}</span>
    </div>
  );
});

const TradeBox = memo(function TradeBox({ trades, strength, hold, release, previousClose }: TradeBoxProps) {
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
      <div className="mw-slot mw-strength" data-testid="ladder-strength"><span className="mw-strength-name">체결강도</span> <b>{formatStrength(strength)}</b></div>
      <div className="mw-tscroll" data-testid="ladder-trades" data-held={held ? "" : undefined} onScroll={(event) => onScroll(event.currentTarget.scrollTop)}>
        {trades.map((row) => <BoxTrade key={row.key} row={row} previousClose={previousClose} />)}
      </div>
    </div>
  );
});

export const tradeSlot = (ladderTrades: LadderTrades, previousClose: number | null) => (): ReactNode => (
  <TradeBox trades={ladderTrades.trades} strength={ladderTrades.strength} hold={ladderTrades.hold} release={ladderTrades.release} previousClose={previousClose} />
);
