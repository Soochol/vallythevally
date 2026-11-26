import { useEffect, useRef } from "react";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import {
  direction,
  formatChange,
  formatMillionWonCompact,
  formatPercent,
  formatPrice,
  formatSignedMillionWonCompact,
  formatVolume,
} from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { isMicroWatchColumn, type WatchColumn } from "../../lib/watchlist";
import { useWatchMicro, type WatchMicroEntry } from "../../stores/watchMicro";
import { useWatchQuote } from "../../stores/watchQuote";
import { DIRECTION_TEXT, RateBadge } from "../list/listRow";

export const quoteCellIds = (base: string, columns: readonly WatchColumn[]) => ({
  name: `${base}-name`,
  kvi: `${base}-kvi`,
  nvi: `${base}-nvi`,
  expected: `${base}-expected`,
  limited: `${base}-limited`,
  column: (column: WatchColumn) => `${base}-${column}`,
  labelledBy: [`${base}-name`, `${base}-kvi`, `${base}-nvi`, ...columns.map((c) => `${base}-${c}`), `${base}-expected`, `${base}-limited`].join(" "),
});

function cellText(column: WatchColumn, quote: Quote | undefined, micro: WatchMicroEntry, isIndex: boolean): string | null {
  switch (column) {
    case "price":
      return quote && Number.isFinite(quote.price) ? formatPrice(quote.price, isIndex) : null;
    case "change":
      return quote && Number.isFinite(quote.change) ? formatChange(quote.change, isIndex) : null;
    case "changeRate":
      return quote && Number.isFinite(quote.changeRate) ? formatPercent(quote.changeRate) : null;
    case "tradedValue":
      return quote?.tradedMillionWon !== undefined && Number.isFinite(quote.tradedMillionWon) ? formatMillionWonCompact(quote.tradedMillionWon) : null;
    case "volume":
      return quote && Number.isFinite(quote.volume) ? formatVolume(quote.volume) : null;
    case "program":
      return micro.programNetMillionWon !== undefined && Number.isFinite(micro.programNetMillionWon) ? formatSignedMillionWonCompact(micro.programNetMillionWon) : null;
    case "whale":
      return micro.whaleNetMillionWon !== undefined && Number.isFinite(micro.whaleNetMillionWon) ? formatSignedMillionWonCompact(micro.whaleNetMillionWon) : null;
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

function tickDuration(): number {
  if (tickDurationMs !== undefined) return tickDurationMs;
  const parsed = parseDurationMs(getComputedStyle(document.documentElement).getPropertyValue("--dur"));
  if (parsed > 0) tickDurationMs = parsed;
  return parsed;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function useTickColor(code: SymbolCode, price: number | undefined) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ code: SymbolCode; price: number | undefined }>({ code, price });
  useEffect(() => {
    const before = previous.current;
    previous.current = { code, price };
    if (before.code !== code) return;
    if (before.price === undefined || price === undefined || !Number.isFinite(price) || !Number.isFinite(before.price) || price === before.price) return;
    if (reducedMotion()) return;
    const node = element.current;
    if (!node) return;
    for (const animation of node.getAnimations()) animation.cancel();
    const duration = tickDuration();
    if (duration <= 0) return;
    const fromColor = getComputedStyle(document.documentElement).getPropertyValue(price > before.price ? "--up" : "--down").trim();
    const toColor = getComputedStyle(node).color.trim();
    if (!fromColor || !toColor) return;
    node.animate([{ color: fromColor }, { color: toColor }], { duration, easing: "ease-out" });
  }, [code, price]);
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
  const needsMicro = columns.some(isMicroWatchColumn);
  const micro = useWatchMicro(code, needsMicro);
  const isIndex = isIndexCode(code);
  const isExpected = quote?.source === "expected";
  const priceTick = useTickColor(code, quote?.price);
  const rowDirection = quote ? direction(quote.change) : "flat";
  const directionOnPrice = !limited && !columns.includes("changeRate") && !columns.includes("change");

  return (
    <>
      {columns.map((column) => {
        const value = cellText(column, quote, micro, isIndex);
        if (column === "price")
          return (
            <span key={column} data-cell={column} className="flex min-w-0 flex-col items-end justify-center text-b font-[500] leading-none">
              <span ref={priceTick} className={`whitespace-nowrap text-right ${directionOnPrice ? DIRECTION_TEXT[rowDirection] : limited ? "text-text-2" : "text-text-price"}`}>
                <span id={ids.column(column)}>{value ?? MISSING}</span>
                {isExpected && <span aria-hidden="true" title="예상체결가">*</span>}
              </span>
            </span>
          );
        if (column === "changeRate")
          return value === null ? (
            <span key={column} data-cell={column} className="text-right text-xs text-text-3"><span id={ids.column(column)}>{MISSING}</span></span>
          ) : (
            <RateBadge key={column} cell={column} id={ids.column(column)} direction={rowDirection}>{value}</RateBadge>
          );
        if (column === "change")
          return (
            <span key={column} data-cell={column} className={`whitespace-nowrap text-right text-xs ${value === null ? "text-text-3" : `font-[600] ${DIRECTION_TEXT[rowDirection]}`}`}>
              <span id={ids.column(column)}>{value ?? MISSING}</span>
            </span>
          );
        if (column === "program" || column === "whale") {
          const raw = column === "program" ? micro.programNetMillionWon : micro.whaleNetMillionWon;
          const tone = raw === undefined ? "text-text-3" : `font-[500] ${DIRECTION_TEXT[direction(raw)]}`;
          return (
            <span key={column} data-cell={column} className={`whitespace-nowrap text-right text-xs ${tone}`}>
              <span id={ids.column(column)}>{value ?? MISSING}</span>
            </span>
          );
        }
        return (
          <span key={column} data-cell={column} className={`whitespace-nowrap text-right text-xs ${value === null ? "text-text-3" : "text-text-2"}`}>
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
