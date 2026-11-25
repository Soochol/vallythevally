import type { MarketOverviewBrokerBook } from "../../api/generated/MarketOverviewBrokerBook";
import type { MarketOverviewDisclosureCategory } from "../../api/generated/MarketOverviewDisclosureCategory";
import type { MarketOverviewDisclosureItem } from "../../api/generated/MarketOverviewDisclosureItem";
import type { MarketOverviewRrgPoint } from "../../api/generated/MarketOverviewRrgPoint";
import type { MarketOverviewRrgQuadrant } from "../../api/generated/MarketOverviewRrgQuadrant";
import type { MarketOverviewRrgSeries } from "../../api/generated/MarketOverviewRrgSeries";
import type { MarketOverviewSessionWindow } from "../../api/generated/MarketOverviewSessionWindow";
import { MINUS } from "../../lib/format";

const whole = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface RrgBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export const RRG_QUADRANT_LABEL: Record<MarketOverviewRrgQuadrant, { ko: string; en: string }> = {
  leading: { ko: "주도", en: "Leading" },
  weakening: { ko: "약화", en: "Weakening" },
  lagging: { ko: "소외", en: "Lagging" },
  improving: { ko: "개선", en: "Improving" },
};

export const rrgQuadrantLabel = (quadrant: MarketOverviewRrgQuadrant): string => RRG_QUADRANT_LABEL[quadrant].ko;

export const rrgQuadrantCaption = (quadrant: MarketOverviewRrgQuadrant): string =>
  `${RRG_QUADRANT_LABEL[quadrant].ko} (${RRG_QUADRANT_LABEL[quadrant].en})`;

export const formatRrgIndex = (value: number): string => twoDecimals.format(value);

export function computeRrgBounds(seriesList: readonly MarketOverviewRrgSeries[], minHalfSpan = 1.5): RrgBounds {
  let maxDx = minHalfSpan;
  let maxDy = minHalfSpan;
  for (const series of seriesList) {
    for (const point of series.points) {
      if (Number.isFinite(point.rsRatio)) maxDx = Math.max(maxDx, Math.abs(point.rsRatio - 100));
      if (Number.isFinite(point.rsMomentum)) maxDy = Math.max(maxDy, Math.abs(point.rsMomentum - 100));
    }
  }
  const padX = maxDx * 1.18;
  const padY = maxDy * 1.18;
  return {
    minX: 100 - padX,
    maxX: 100 + padX,
    minY: 100 - padY,
    maxY: 100 + padY,
  };
}

export function projectRrgPoint(
  point: Pick<MarketOverviewRrgPoint, "rsRatio" | "rsMomentum">,
  bounds: RrgBounds,
  width: number,
  height: number,
  pad: number,
): Point2D {
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  const ratioX = (point.rsRatio - bounds.minX) / spanX;
  const ratioY = (bounds.maxY - point.rsMomentum) / spanY;
  return {
    x: pad + Math.min(1, Math.max(0, ratioX)) * innerW,
    y: pad + Math.min(1, Math.max(0, ratioY)) * innerH,
  };
}

export function rrgTrailPath(points: readonly Point2D[]): string {
  if (points.length < 2) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

export function rrgArrowPolygon(points: readonly Point2D[], length = 7, halfWidth = 3.5): string {
  if (points.length < 2) return "";
  const tip = points.at(-1)!;
  let anchor = points.at(-2)!;
  for (let idx = points.length - 2; idx >= 0; idx -= 1) {
    const candidate = points[idx]!;
    if (Math.hypot(tip.x - candidate.x, tip.y - candidate.y) > 0.5) {
      anchor = candidate;
      break;
    }
  }
  const dx = tip.x - anchor.x;
  const dy = tip.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0.5) return "";
  const ux = dx / dist;
  const uy = dy / dist;
  const baseX = tip.x - ux * length;
  const baseY = tip.y - uy * length;
  const px = -uy * halfWidth;
  const py = ux * halfWidth;
  return `${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${(baseX + px).toFixed(1)},${(baseY + py).toFixed(1)} ${(baseX - px).toFixed(1)},${(baseY - py).toFixed(1)}`;
}

export const SESSION_SUBJECTS = [
  { key: "foreignDeltaEok", id: "foreign", label: "외국인" },
  { key: "institutionDeltaEok", id: "institution", label: "기관" },
  { key: "individualDeltaEok", id: "individual", label: "개인" },
  { key: "programDeltaEok", id: "program", label: "프로그램" },
] as const;

export type SessionSubjectKey = (typeof SESSION_SUBJECTS)[number]["key"];

export function sessionMaxAbsEok(windows: readonly MarketOverviewSessionWindow[]): number {
  let maxAbs = 0;
  for (const window of windows) {
    for (const subject of SESSION_SUBJECTS) {
      const value = Math.abs(window[subject.key]);
      if (Number.isFinite(value) && value > maxAbs) maxAbs = value;
    }
  }
  return maxAbs > 0 ? maxAbs : 1;
}

export function sessionBarPercent(deltaEok: number, maxAbs: number): number {
  if (!Number.isFinite(deltaEok) || maxAbs <= 0) return 0;
  const raw = (Math.abs(deltaEok) / maxAbs) * 100;
  return Math.min(100, Math.max(deltaEok === 0 ? 0 : 4, raw));
}

export function venueSplitOf(krxTradeValueEok: number, nxtTradeValueEok: number): {
  krxPct: number;
  nxtPct: number;
  totalEok: number;
} {
  const krx = Math.max(0, Number.isFinite(krxTradeValueEok) ? krxTradeValueEok : 0);
  const nxt = Math.max(0, Number.isFinite(nxtTradeValueEok) ? nxtTradeValueEok : 0);
  const totalEok = krx + nxt;
  if (totalEok <= 0) return { krxPct: 0, nxtPct: 0, totalEok: 0 };
  const krxPct = Math.round((krx / totalEok) * 1000) / 10;
  const nxtPct = Math.round((100 - krxPct) * 10) / 10;
  return { krxPct, nxtPct, totalEok };
}

export function orderbookPressureOf(
  book: Pick<MarketOverviewBrokerBook, "totalBidRemaining" | "totalAskRemaining" | "buyPressurePct">,
): { buyPct: number; sellPct: number } {
  if (book.totalBidRemaining <= 0 && book.totalAskRemaining <= 0) {
    return { buyPct: 0, sellPct: 0 };
  }
  const buyPct = Math.min(100, Math.max(0, Number.isFinite(book.buyPressurePct) ? book.buyPressurePct : 0));
  const sellPct = Math.round((100 - buyPct) * 10) / 10;
  return { buyPct, sellPct };
}

export function formatShares(shares: number): string {
  const abs = Math.abs(shares);
  const sign = shares < 0 ? MINUS : "";
  if (abs >= 100_000_000) return `${sign}${oneDecimal.format(abs / 100_000_000)}억주`;
  if (abs >= 10_000) return `${sign}${oneDecimal.format(abs / 10_000)}만주`;
  return `${sign}${whole.format(abs)}주`;
}

export const signedShares = (shares: number): string => (shares > 0 ? "+" : "") + formatShares(shares);

export type DisclosureFilter = "all" | MarketOverviewDisclosureCategory;

export const DISCLOSURE_FILTERS = [
  { id: "all", label: "전체" },
  { id: "contract", label: "수주·계약" },
  { id: "shareholder", label: "주주환원" },
  { id: "earnings", label: "실적" },
  { id: "capital", label: "증자·CB" },
] as const satisfies readonly { id: DisclosureFilter; label: string }[];

export const DISCLOSURE_CATEGORY_LABEL: Record<MarketOverviewDisclosureCategory, string> = {
  contract: "수주·계약",
  shareholder: "주주환원",
  earnings: "실적",
  capital: "증자·CB",
};

export const disclosureCategoryLabel = (category: MarketOverviewDisclosureCategory): string =>
  DISCLOSURE_CATEGORY_LABEL[category];

export function disclosureCountFor(
  items: readonly MarketOverviewDisclosureItem[],
  filter: DisclosureFilter,
): number {
  if (filter === "all") return items.length;
  return items.reduce((sum, item) => (item.category === filter ? sum + 1 : sum), 0);
}

export function filterDisclosures(
  items: readonly MarketOverviewDisclosureItem[],
  filter: DisclosureFilter,
): MarketOverviewDisclosureItem[] {
  if (filter === "all") return [...items];
  return items.filter((item) => item.category === filter);
}

export function formatReceiptDate(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
  return raw;
}
