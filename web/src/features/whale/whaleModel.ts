import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WhaleEvent } from "../../api/generated/WhaleEvent";
import type { WhaleSide } from "../../api/generated/WhaleSide";
import { MINUS } from "../../lib/format";

export type WhaleViewMode = "stream" | "rank";
export type WhaleSideFilter = "all" | WhaleSide;
export type WhaleRankSort = "count" | "net" | "total";

export interface WhalePreset {
  readonly key: string;
  readonly label: string;
  readonly minWon: number;
}

export const WHALE_MIN_PRESETS: readonly WhalePreset[] = Object.freeze([
  { key: "30m", label: "3천", minWon: 30_000_000 },
  { key: "50m", label: "5천", minWon: 50_000_000 },
  { key: "100m", label: "1억", minWon: 100_000_000 },
  { key: "300m", label: "3억", minWon: 300_000_000 },
  { key: "500m", label: "5억+", minWon: 500_000_000 },
]);

export const DEFAULT_WHALE_MIN_WON = 100_000_000;
export const WHALE_CUSTOM_MIN_WON = 10_000_000;

export interface WhaleRankRow {
  readonly symbol: SymbolCode;
  readonly name: string;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly totalCount: number;
  readonly buyWon: number;
  readonly sellWon: number;
  readonly totalWon: number;
  readonly netWon: number;
  readonly lastPrice: number;
  readonly lastAt: number;
}

export function parseCustomWon(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(억|만|천만?)?$/.exec(trimmed);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  let won: number;
  if (unit === "억") won = Math.round(value * 100_000_000);
  else if (unit === "천" || unit === "천만") won = Math.round(value * 10_000_000);
  else if (unit === "만") won = Math.round(value * 10_000);
  else won = value >= 1_000 ? Math.round(value * 10_000) : Math.round(value * 100_000_000);
  return won >= WHALE_CUSTOM_MIN_WON ? won : WHALE_CUSTOM_MIN_WON;
}

export function formatWhaleWon(won: number, signed = false): string {
  const abs = Math.abs(won);
  const sign = signed ? (won > 0 ? "+" : won < 0 ? MINUS : "") : won < 0 ? MINUS : "";
  if (abs >= 100_000_000) {
    const eok = abs / 100_000_000;
    return `${sign}${eok.toFixed(abs >= 1_000_000_000 ? 1 : 2)}억`;
  }
  return `${sign}${Math.round(abs / 10_000).toLocaleString("ko-KR")}만`;
}

export function formatWhaleTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const hh = String((date.getUTCHours() + 9) % 24).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function filterWhaleEvents(
  events: readonly WhaleEvent[],
  minWon: number,
  side: WhaleSideFilter,
  query: string,
  nameOf: (code: SymbolCode) => string,
): WhaleEvent[] {
  const q = query.trim().toLowerCase();
  return events.filter((ev) => {
    if (ev.amountWon < minWon) return false;
    if (side !== "all" && ev.side !== side) return false;
    if (!q) return true;
    return ev.symbol.toLowerCase().includes(q) || nameOf(ev.symbol).toLowerCase().includes(q);
  });
}

export function aggregateWhaleRows(
  events: readonly WhaleEvent[],
  sort: WhaleRankSort,
  nameOf: (code: SymbolCode) => string,
): WhaleRankRow[] {
  const map = new Map<
    SymbolCode,
    {
      symbol: SymbolCode;
      name: string;
      buyCount: number;
      sellCount: number;
      buyWon: number;
      sellWon: number;
      lastPrice: number;
      lastAt: number;
    }
  >();
  for (const ev of events) {
    let row = map.get(ev.symbol);
    if (!row) {
      row = {
        symbol: ev.symbol,
        name: nameOf(ev.symbol),
        buyCount: 0,
        sellCount: 0,
        buyWon: 0,
        sellWon: 0,
        lastPrice: ev.price,
        lastAt: ev.at,
      };
      map.set(ev.symbol, row);
    }
    if (ev.side === "buy") {
      row.buyCount += 1;
      row.buyWon += ev.amountWon;
    } else {
      row.sellCount += 1;
      row.sellWon += ev.amountWon;
    }
    if (ev.at >= row.lastAt) {
      row.lastAt = ev.at;
      row.lastPrice = ev.price;
    }
  }
  const rows: WhaleRankRow[] = Array.from(map.values(), (row) => ({
    ...row,
    totalCount: row.buyCount + row.sellCount,
    totalWon: row.buyWon + row.sellWon,
    netWon: row.buyWon - row.sellWon,
  }));
  rows.sort((a, b) => {
    if (sort === "net") return b.netWon - a.netWon || b.totalWon - a.totalWon;
    if (sort === "total") return b.totalWon - a.totalWon || b.totalCount - a.totalCount;
    return b.totalCount - a.totalCount || b.totalWon - a.totalWon;
  });
  return rows;
}
