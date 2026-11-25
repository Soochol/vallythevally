import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import type { EtfStyle } from "../../api/generated/EtfStyle";

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

export type FundSort = "name" | "top5" | "count";

export const SORT_CHOICES: readonly { value: FundSort; label: string }[] = [
  { value: "name", label: "이름순" },
  { value: "top5", label: "상위 5 비중순" },
  { value: "count", label: "종목 수순" },
];

export function sortFunds(funds: readonly EtfFundSummary[], sort: FundSort): EtfFundSummary[] {
  if (sort === "top5") return funds.toSorted((a, b) => b.top5WeightBps - a.top5WeightBps);
  if (sort === "count") return funds.toSorted((a, b) => b.holdingsCount - a.holdingsCount);
  return funds.toSorted((a, b) => a.name.localeCompare(b.name, "ko"));
}

export function issuersOf(funds: readonly EtfFundSummary[]): string[] {
  return [...new Set(funds.map((fund) => fund.issuer))].sort((a, b) => a.localeCompare(b, "ko"));
}

export const percentOfBps = (bps: number): number => bps / 100;

export const formatPercent = (bps: number): string => `${percentOfBps(bps).toFixed(2)}%`;

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

/** 정사각형에 가깝게 배치한다(squarified treemap). 입력은 가중치 내림차순으로 정렬해 쓴다. 가중치가 0 이하인 칸은 뺀다. */
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

export const overlapBps = (a: readonly WeightedHolding[], b: readonly WeightedHolding[]): number =>
  commonHoldings(a, b).reduce((sum, holding) => sum + Math.min(holding.weightABps, holding.weightBBps), 0);

export function parseBasket(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").filter((code) => code !== ""))].slice(0, BASKET_LIMIT);
}

export const pairOf = (pairs: readonly EtfChangePair[], after: string | null): EtfChangePair | null => pairs.find((pair) => pair.after === after) ?? pairs[0] ?? null;

export const formatScale = (scale: number | null): string => (scale === null ? "-" : `×${scale.toFixed(3)}`);

export const formatRealChange = (change: number): string => `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

export const formatQuantity = (quantity: number | null): string => (quantity === null ? "-" : quantity.toLocaleString("en-US", { maximumFractionDigits: 4 }));

export const formatMedianRealChange = (change: number | null): string => (change === null ? "-" : formatRealChange(change));

export const formatAccumulationPeriod = (fromDate: string | null, toDate: string | null, collectedDays: number): string | null =>
  fromDate !== null && toDate !== null ? `${fromDate} ~ ${toDate} · 수집일 ${collectedDays}일` : null;

export const formatBuyingSummary = (buyingEtfCount: number, addedEtfCount: number): string =>
  addedEtfCount > 0 ? `${buyingEtfCount}개 (신규 ${addedEtfCount})` : `${buyingEtfCount}개`;
