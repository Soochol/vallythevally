import { useEffect, useRef } from "react";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import type { WatchColumn } from "../../lib/watchlist";
import { useWatchQuote } from "../../stores/watchQuote";
import { DIRECTION_TEXT, RateBadge } from "../list/listRow";

export const quoteCellIds = (base: string, columns: readonly WatchColumn[]) => ({
  name: `${base}-name`,
  expected: `${base}-expected`,
  limited: `${base}-limited`,
  column: (column: WatchColumn) => `${base}-${column}`,
  labelledBy: [`${base}-name`, ...columns.map((c) => `${base}-${c}`), `${base}-expected`, `${base}-limited`].join(" "),
});

function cellText(column: WatchColumn, quote: Quote, isIndex: boolean): string {
  switch (column) {
    case "price":
      return formatPrice(quote.price, isIndex);
    case "change":
      return formatChange(quote.change, isIndex);
    case "changeRate":
      return formatPercent(quote.changeRate);
    case "volume":
      return formatVolume(quote.volume);
  }
}

const MILLISECONDS_PER_SECOND = 1000;

export function parseDurationMs(raw: string): number {
  const text = raw.trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return 0;
  return text.endsWith("ms") ? amount : text.endsWith("s") ? amount * MILLISECONDS_PER_SECOND : 0;
}

let tickDurationMs: number | undefined;
const tickDuration = () => (tickDurationMs ??= parseDurationMs(getComputedStyle(document.documentElement).getPropertyValue("--dur")));
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function useTickColor(price: number | undefined) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef(price);
  useEffect(() => {
    const before = previous.current;
    previous.current = price;
    if (before === undefined || price === undefined || price === before || reducedMotion()) return;
    element.current?.animate([{ color: price > before ? "var(--up)" : "var(--down)" }, {}], { duration: tickDuration(), easing: "ease-out" });
  }, [price]);
  return element;
}

const MISSING = <span aria-hidden="true">—</span>;

interface QuoteCellsProps {
  code: SymbolCode;
  columns: readonly WatchColumn[];
  ids: ReturnType<typeof quoteCellIds>;
}

export function QuoteCells({ code, columns, ids }: QuoteCellsProps) {
  const { quote, limited } = useWatchQuote(code);
  const isIndex = isIndexCode(code);
  const isExpected = quote?.source === "expected";
  const priceTick = useTickColor(quote?.price);
  const rowDirection = quote ? direction(quote.change) : "flat";
  const directionOnPrice = !limited && !columns.includes("changeRate") && !columns.includes("change");
  const text = (column: WatchColumn) => (quote ? cellText(column, quote, isIndex) : null);

  return (
    <>
      {columns.map((column) => {
        const value = text(column);
        if (column === "price")
          return (
            <span key={column} data-cell={column} className="flex min-w-0 flex-col items-end justify-center text-m leading-none">
              <span ref={priceTick} className={`whitespace-nowrap text-right ${directionOnPrice ? DIRECTION_TEXT[rowDirection] : limited ? "text-text-2" : ""}`}>
                <span id={ids.column(column)}>{value ?? MISSING}</span>
                {isExpected && <span aria-hidden="true" title="예상체결가">*</span>}
              </span>
            </span>
          );
        if (column === "changeRate")
          return value === null ? (
            <span key={column} data-cell={column} className="text-right text-text-3"><span id={ids.column(column)}>{MISSING}</span></span>
          ) : (
            <RateBadge key={column} cell={column} id={ids.column(column)} direction={rowDirection}>{value}</RateBadge>
          );
        return (
          <span key={column} data-cell={column} className={`whitespace-nowrap text-right ${column === "change" && quote ? `text-s font-[600] ${DIRECTION_TEXT[rowDirection]}` : ""}`}>
            <span id={ids.column(column)}>{value ?? MISSING}</span>
          </span>
        );
      })}
      <span id={ids.expected} className="sr-only">{isExpected ? "예상체결" : ""}</span>
      <span id={ids.limited} className="sr-only">{limited ? "실시간 아님" : ""}</span>
      {limited && columns.length > 0 && <span aria-hidden="true" title="실시간 아님" className="absolute right-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-warning" />}
    </>
  );
}
