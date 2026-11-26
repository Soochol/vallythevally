import type { EtfAccumulationDirection } from "../../api/generated/EtfAccumulationDirection";
import type { EtfAccumulationRow } from "../../api/generated/EtfAccumulationRow";
import type { EtfChangeKind } from "../../api/generated/EtfChangeKind";
import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import type { EtfMaStates } from "../../api/generated/EtfMaStates";
import type { EtfRecentActivity } from "../../api/generated/EtfRecentActivity";
import type { EtfStyle } from "../../api/generated/EtfStyle";

export type GlobalTabId = "accumulation" | "flows" | "overlap" | "reverse";
export type FundTabId = "holdings" | "history" | "shares" | "similar";
export type TabId = GlobalTabId | FundTabId;

export function isGlobalTab(tab: TabId): tab is GlobalTabId {
  return tab === "accumulation" || tab === "flows" || tab === "overlap" || tab === "reverse";
}

export type StyleFilter = EtfStyle | "all";

export interface FundFilter {
  query: string;
  style: StyleFilter;
  issuer: string | null;
}

export const NO_FILTER: FundFilter = { query: "", style: "all", issuer: null };

export function filterFunds(funds: readonly EtfFundSummary[], filter: FundFilter): EtfFundSummary[] {
  const query = filter.query.trim().toLowerCase();
  return funds.filter(
    (fund) =>
      (filter.style === "all" || fund.style === filter.style) &&
      (filter.issuer === null || fund.issuer === filter.issuer) &&
      (query === "" || fund.name.toLowerCase().includes(query) || fund.code.toLowerCase().includes(query)),
  );
}

export type FundSort = "name" | "flow_in" | "flow_out" | "aum" | "top5" | "effective" | "activity" | "count";

export const SORT_CHOICES: readonly { value: FundSort; label: string }[] = [
  { value: "name", label: "이름순" },
  { value: "flow_in", label: "5일 유입순" },
  { value: "flow_out", label: "5일 유출순" },
  { value: "aum", label: "순자산순" },
  { value: "top5", label: "상위 5 비중순" },
  { value: "effective", label: "실효 종목순" },
  { value: "activity", label: "최근 리밸런싱순" },
  { value: "count", label: "종목 수순" },
];

export function activityScore(activity: EtfRecentActivity | null): number {
  if (activity === null) return -1;
  return activity.added * 3 + activity.increased * 2 + activity.removed * 2 + activity.decreased;
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function sortFunds(funds: readonly EtfFundSummary[], sort: FundSort): EtfFundSummary[] {
  if (sort === "flow_in") {
    return funds.toSorted(
      (a, b) => compareNullableDesc(a.netFlow5dWon, b.netFlow5dWon) || a.name.localeCompare(b.name, "ko"),
    );
  }
  if (sort === "flow_out") {
    return funds.toSorted(
      (a, b) => compareNullableAsc(a.netFlow5dWon, b.netFlow5dWon) || a.name.localeCompare(b.name, "ko"),
    );
  }
  if (sort === "aum") {
    return funds.toSorted(
      (a, b) => compareNullableDesc(a.latestAumWon, b.latestAumWon) || a.name.localeCompare(b.name, "ko"),
    );
  }
  if (sort === "top5") return funds.toSorted((a, b) => b.top5WeightBps - a.top5WeightBps);
  if (sort === "count") return funds.toSorted((a, b) => b.holdingsCount - a.holdingsCount);
  if (sort === "effective") return funds.toSorted((a, b) => a.effectiveHoldings - b.effectiveHoldings || a.name.localeCompare(b.name, "ko"));
  if (sort === "activity") {
    return funds.toSorted(
      (a, b) => activityScore(b.recentActivity) - activityScore(a.recentActivity) || a.name.localeCompare(b.name, "ko"),
    );
  }
  return funds.toSorted((a, b) => a.name.localeCompare(b.name, "ko"));
}

export function issuersOf(funds: readonly EtfFundSummary[]): string[] {
  return [...new Set(funds.map((fund) => fund.issuer))].sort((a, b) => a.localeCompare(b, "ko"));
}

export const percentOfBps = (bps: number): number => bps / 100;

export const formatPercent = (bps: number): string => `${percentOfBps(bps).toFixed(2)}%`;

export type TreemapLens = "weight" | "ma" | "flow";

export function maAlignedCount(ma: EtfMaStates): number {
  let count = 0;
  if (ma.ma20 === "above") count += 1;
  if (ma.ma60 === "above") count += 1;
  if (ma.ma120 === "above") count += 1;
  return count;
}

export interface HoldingsBreadth {
  evaluated: number;
  above20Pct: number;
  aligned3Pct: number;
}

export function holdingsBreadth(holdings: readonly EtfHolding[]): HoldingsBreadth {
  let evaluated = 0;
  let above20 = 0;
  let aligned3 = 0;
  for (const holding of holdings) {
    const { ma20, ma60, ma120 } = holding.ma;
    if (ma20 !== null || ma60 !== null || ma120 !== null) {
      evaluated += 1;
      if (ma20 === "above") above20 += 1;
      if (maAlignedCount(holding.ma) === 3) aligned3 += 1;
    }
  }
  if (evaluated === 0) return { evaluated: 0, above20Pct: 0, aligned3Pct: 0 };
  return {
    evaluated,
    above20Pct: Math.round((above20 / evaluated) * 100),
    aligned3Pct: Math.round((aligned3 / evaluated) * 100),
  };
}

export interface TreemapInput {
  key: string;
  weight: number;
}

export interface TreemapTile {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function worstRatio(areas: readonly number[], side: number): number {
  const sum = areas.reduce((total, area) => total + area, 0);
  const thickness = sum / side;
  return Math.max(...areas.map((area) => Math.max(area / (thickness * thickness), (thickness * thickness) / area)));
}

export function squarify(inputs: readonly TreemapInput[], width: number, height: number): TreemapTile[] {
  const items = inputs.filter((item) => item.weight > 0).toSorted((a, b) => b.weight - a.weight);
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (items.length === 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = items.map((item) => item.weight * scale);
  const tiles: TreemapTile[] = [];
  let box: Box = { x: 0, y: 0, width, height };
  let start = 0;
  while (start < items.length) {
    const side = Math.min(box.width, box.height);
    let end = start + 1;
    while (end < items.length && worstRatio(areas.slice(start, end + 1), side) <= worstRatio(areas.slice(start, end), side)) end += 1;
    const rowAreas = areas.slice(start, end);
    const rowSum = rowAreas.reduce((sum, area) => sum + area, 0);
    const horizontal = box.width >= box.height;
    const thickness = rowSum / side;
    let offset = 0;
    for (let i = start; i < end; i += 1) {
      const length = areas[i]! / thickness;
      tiles.push(
        horizontal
          ? { key: items[i]!.key, x: box.x, y: box.y + offset, width: thickness, height: length }
          : { key: items[i]!.key, x: box.x + offset, y: box.y, width: length, height: thickness },
      );
      offset += length;
    }
    box = horizontal
      ? { x: box.x + thickness, y: box.y, width: box.width - thickness, height: box.height }
      : { x: box.x, y: box.y + thickness, width: box.width, height: box.height - thickness };
    start = end;
  }
  return tiles;
}

export interface CurvePoint {
  rank: number;
  cumulativeBps: number;
}

export interface RankedHolding<T extends WeightedHolding> {
  holding: T;
  rank: number;
  cumulativeBps: number;
}

export function rankHoldings<T extends WeightedHolding>(holdings: readonly T[]): RankedHolding<T>[] {
  let sum = 0;
  return holdings.map((holding, index) => {
    sum += holding.weightBps;
    return { holding, rank: index + 1, cumulativeBps: sum };
  });
}

export const BASKET_LIMIT = 4;

export type WeightedHolding = Pick<EtfHolding, "code" | "name" | "weightBps">;

export interface CommonHolding {
  code: string;
  name: string;
  weightABps: number;
  weightBBps: number;
}

export function commonHoldings(a: readonly WeightedHolding[], b: readonly WeightedHolding[]): CommonHolding[] {
  const weightsB = new Map(b.map((holding) => [holding.code, holding.weightBps]));
  return a
    .flatMap((holding) => {
      const weightBBps = weightsB.get(holding.code);
      return weightBBps === undefined ? [] : [{ code: holding.code, name: holding.name, weightABps: holding.weightBps, weightBBps }];
    })
    .toSorted((x, y) => Math.min(y.weightABps, y.weightBBps) - Math.min(x.weightABps, x.weightBBps));
}

export function uniqueHoldings(a: readonly WeightedHolding[], b: readonly WeightedHolding[]): { onlyA: WeightedHolding[]; onlyB: WeightedHolding[] } {
  const codesA = new Set(a.map((holding) => holding.code));
  const codesB = new Set(b.map((holding) => holding.code));
  return {
    onlyA: a.filter((holding) => !codesB.has(holding.code)).toSorted((x, y) => y.weightBps - x.weightBps),
    onlyB: b.filter((holding) => !codesA.has(holding.code)).toSorted((x, y) => y.weightBps - x.weightBps),
  };
}

export const overlapBps = (a: readonly WeightedHolding[], b: readonly WeightedHolding[]): number =>
  commonHoldings(a, b).reduce((sum, holding) => sum + Math.min(holding.weightABps, holding.weightBBps), 0);

export function parseBasket(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").filter((code) => code !== ""))].slice(0, BASKET_LIMIT);
}

export const pairOf = (pairs: readonly EtfChangePair[], after: string | null): EtfChangePair | null => pairs.find((pair) => pair.after === after) ?? pairs[0] ?? null;

export function fullRangePair(pairs: readonly EtfChangePair[]): { before: string; after: string } | null {
  if (pairs.length < 2) return null;
  return { before: pairs[pairs.length - 1]!.before, after: pairs[0]!.after };
}

export function isMaInverseAligned(ma: EtfMaStates): boolean {
  return ma.ma20 === "below" && ma.ma60 === "below" && ma.ma120 === "below";
}

export type RadarChipFilter = "all" | "added" | "aligned" | "multi";

export function filterAccumulationRows(
  rows: readonly EtfAccumulationRow[],
  chip: RadarChipFilter,
  direction: EtfAccumulationDirection = "buy",
): EtfAccumulationRow[] {
  if (direction === "sell") {
    if (chip === "added") return rows.filter((row) => row.removedEtfCount > 0);
    if (chip === "aligned") return rows.filter((row) => isMaInverseAligned(row.ma));
    if (chip === "multi") return rows.filter((row) => row.sellingEtfCount >= 3);
    return [...rows];
  }
  if (chip === "added") return rows.filter((row) => row.addedEtfCount > 0);
  if (chip === "aligned") return rows.filter((row) => maAlignedCount(row.ma) === 3);
  if (chip === "multi") return rows.filter((row) => row.buyingEtfCount >= 3);
  return [...rows];
}

export interface RadarSummary {
  total: number;
  edgeStocks: number;
  trendStocks: number;
  topRow: EtfAccumulationRow | null;
}

export function radarSummary(
  rows: readonly EtfAccumulationRow[],
  direction: EtfAccumulationDirection = "buy",
): RadarSummary {
  let edgeStocks = 0;
  let trendStocks = 0;
  let topRow: EtfAccumulationRow | null = null;
  for (const row of rows) {
    if (direction === "sell") {
      if (row.removedEtfCount > 0) edgeStocks += 1;
      if (isMaInverseAligned(row.ma)) trendStocks += 1;
      if (topRow === null || row.sellingEtfCount > topRow.sellingEtfCount) topRow = row;
    } else {
      if (row.addedEtfCount > 0) edgeStocks += 1;
      if (maAlignedCount(row.ma) === 3) trendStocks += 1;
      if (topRow === null || row.buyingEtfCount > topRow.buyingEtfCount) topRow = row;
    }
  }
  return { total: rows.length, edgeStocks, trendStocks, topRow };
}

export type HistoryKindFilter = "all" | "changed" | "buy" | "sell";

export interface DisplayedChangeRow {
  row: EtfChangeRow;
  change: number | null;
  kind: EtfChangeKind;
  rawChange: number | null;
  isScaleNoise: boolean;
}

const CHANGE_THRESHOLD = 0.01;

export function projectChangeRow(row: EtfChangeRow, xrayOn: boolean): DisplayedChangeRow {
  const rawChange =
    row.beforeQuantity !== null && row.afterQuantity !== null && row.beforeQuantity > 0
      ? (row.afterQuantity - row.beforeQuantity) / row.beforeQuantity
      : null;
  const isScaleNoise = row.kind === "unchanged" && rawChange !== null && Math.abs(rawChange) > CHANGE_THRESHOLD;
  if (xrayOn) {
    return { row, change: row.realChange, kind: row.kind, rawChange, isScaleNoise };
  }
  if (row.kind === "added" || row.kind === "removed" || rawChange === null) {
    return { row, change: null, kind: row.kind, rawChange, isScaleNoise };
  }
  const kind: EtfChangeKind =
    Math.abs(rawChange) <= CHANGE_THRESHOLD ? "unchanged" : rawChange > CHANGE_THRESHOLD ? "increased" : "decreased";
  return { row, change: rawChange, kind, rawChange, isScaleNoise };
}

export function filterChangeRows(rows: readonly DisplayedChangeRow[], filter: HistoryKindFilter): DisplayedChangeRow[] {
  if (filter === "changed") return rows.filter((item) => item.kind !== "unchanged");
  if (filter === "buy") return rows.filter((item) => item.kind === "added" || item.kind === "increased");
  if (filter === "sell") return rows.filter((item) => item.kind === "removed" || item.kind === "decreased");
  return [...rows];
}

export const formatScale = (scale: number | null): string => (scale === null ? "-" : `×${scale.toFixed(3)}`);

export const formatRealChange = (change: number): string => `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

export const formatQuantity = (quantity: number | null): string => (quantity === null ? "-" : quantity.toLocaleString("en-US", { maximumFractionDigits: 4 }));

export const formatMedianRealChange = (change: number | null): string => (change === null ? "-" : formatRealChange(change));

export const formatAccumulationPeriod = (fromDate: string | null, toDate: string | null, collectedDays: number): string | null =>
  fromDate !== null && toDate !== null ? `${fromDate} ~ ${toDate} · 수집일 ${collectedDays}일` : null;

export const formatBuyingSummary = (buyingEtfCount: number, addedEtfCount: number): string =>
  addedEtfCount > 0 ? `${buyingEtfCount}개 (신규 ${addedEtfCount})` : `${buyingEtfCount}개`;

export function formatFlowWon(won: number | null, signed = true): string {
  if (won === null) return "-";
  const eok = won / 1e8;
  const sign = signed && eok > 0 ? "+" : "";
  if (Math.abs(eok) >= 10_000) return `${sign}${(eok / 10_000).toFixed(2)}조`;
  if (Math.abs(eok) >= 100) return `${sign}${Math.round(eok).toLocaleString("ko-KR")}억`;
  if (Math.abs(eok) >= 0.05) return `${sign}${eok.toFixed(1)}억`;
  return "0억";
}

export function formatAumWon(won: number | null): string {
  if (won === null || won <= 0) return "-";
  const eok = won / 1e8;
  if (eok >= 10_000) return `${(eok / 10_000).toFixed(2)}조원`;
  if (eok >= 1) return `${Math.round(eok).toLocaleString("ko-KR")}억원`;
  return `${Math.round(won / 1e4).toLocaleString("ko-KR")}만원`;
}

export function formatSharesCount(shares: number | null, signed = false): string {
  if (shares === null) return "-";
  const sign = signed && shares > 0 ? "+" : "";
  const abs = Math.abs(shares);
  if (abs >= 1e8) return `${sign}${(shares / 1e8).toFixed(2)}억좌`;
  if (abs >= 1e4) return `${sign}${Math.round(shares / 1e4).toLocaleString("ko-KR")}만좌`;
  return `${sign}${shares.toLocaleString("ko-KR")}좌`;
}

export function formatSignedPercent(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "-";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function formatPremiumBps(bps: number | null): string {
  if (bps === null) return "-";
  const pct = bps / 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function flowDirectionOf(value: number | null): "up" | "down" | "flat" {
  if (value === null || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}
