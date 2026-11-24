import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { formatPrice } from "../../lib/format";
import { formatStrength } from "./format";
import type { InfoPager, LadderTrades } from "./useLadderSlots";
import { priceTone } from "./PriceLadder";
import type { TradeRow } from "../trades/tape";
import { INFO_TABS, type InfoKey, type InfoLine, type InfoPage, otherInfoPage } from "./quoteInfo";

const sameLine = (a: InfoLine, b: InfoLine): boolean =>
  a === b || (a.key === b.key && a.flipped === b.flipped && a.item.label === b.item.label && a.item.value === b.item.value && a.item.tone === b.item.tone);

const sameLines = (a: readonly InfoLine[], b: readonly InfoLine[]): boolean =>
  a === b || (a.length === b.length && a.every((line, index) => sameLine(line, b[index]!)));

const InfoRow = memo(function InfoRow({ line, onToggle }: { line: InfoLine; onToggle: (key: InfoKey) => void }) {
  const { item } = line;
  const content = <><span>{item.label}</span><b data-tone={item.tone ?? undefined}>{item.value}</b></>;
  if (line.key === undefined) {
    return (
      <div className="mw-card-row" data-testid="ladder-info" data-label={item.label} data-warn={item.tone === "warning" ? "" : undefined}>
        {content}
      </div>
    );
  }
  const key = line.key;
  return (
    <button type="button" className="mw-card-row" data-testid="ladder-info" data-label={item.label} data-flipped={line.flipped ? "" : undefined} data-warn={item.tone === "warning" ? "" : undefined} aria-pressed={Boolean(line.flipped)} onClick={() => onToggle(key)}>
      {content}
    </button>
  );
}, (a, b) => a.onToggle === b.onToggle && sameLine(a.line, b.line));

const InfoTabs = memo(function InfoTabs({ page, select }: { page: InfoPage; select: InfoPager["select"] }) {
  const refs = useRef<Partial<Record<InfoPage, HTMLButtonElement | null>>>({});
  const flipPage = () => select(otherInfoPage(page));
  const choose = (target: InfoPage) => {
    select(target);
    refs.current[target]?.focus();
  };
  return (
    <div className="mw-card-dots" role="tablist" aria-label="상세 정보" onClick={flipPage} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      {INFO_TABS.map(({ page: tabPage, label }) => (
        <button key={tabPage} ref={(node) => { refs.current[tabPage] = node; }} type="button" role="tab" aria-label={label} title={label} aria-selected={page === tabPage} tabIndex={page === tabPage ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            choose(otherInfoPage(tabPage));
          }} />
      ))}
    </div>
  );
});

const InfoCard = memo(function InfoCard({ lines, rows, page, select, toggle }: { lines: readonly InfoLine[]; rows: number; page: InfoPage; select: InfoPager["select"]; toggle: InfoPager["toggle"] }) {
  return (
    <div className="mw-card" data-testid="ladder-info-card" style={{ height: `calc(${rows} * var(--size-24))` }}>
      {lines.map((line, index) => <InfoRow key={index} line={line} onToggle={toggle} />)}
      <InfoTabs page={page} select={select} />
    </div>
  );
}, (a, b) => a.rows === b.rows && a.page === b.page && a.select === b.select && a.toggle === b.toggle && sameLines(a.lines, b.lines));

export const infoSlot = (lines: readonly InfoLine[], pager: InfoPager) => (rowCount: number): ReactNode => (
  <InfoCard lines={lines} rows={rowCount} page={pager.page} select={pager.select} toggle={pager.toggle} />
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

const ReplayTradeBox = memo(function ReplayTradeBox({ trades, previousClose }: { readonly trades: readonly TradeRow[]; readonly previousClose: number | null }) {
  return (
    <div className="mw-tbox">
      <div className="mw-tscroll" data-testid="ladder-trades">
        {trades.map((row) => <BoxTrade key={row.key} row={row} previousClose={previousClose} />)}
      </div>
    </div>
  );
});

export const replayTradeSlot = (trades: readonly TradeRow[], previousClose: number | null) => (): ReactNode => (
  <ReplayTradeBox trades={trades} previousClose={previousClose} />
);
