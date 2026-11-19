import type { EtfFundSummary } from "../../api/generated/EtfFundSummary";
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

/** 비중 큰 순으로 쌓은 누적 비중. 비중은 다시 100%로 맞추지 않는다. */
export function cumulativeCurve(weightsBps: readonly number[]): CurvePoint[] {
  let sum = 0;
  return weightsBps.toSorted((a, b) => b - a).map((weight, index) => {
    sum += weight;
    return { rank: index + 1, cumulativeBps: sum };
  });
}
