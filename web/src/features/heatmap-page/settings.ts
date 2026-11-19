import { COLOR_RANGES, type ColorRange, DEFAULT_COLOR_RANGE } from "./colors";

export const SIZE_MODES = ["traded", "equal"] as const;
export type SizeMode = (typeof SIZE_MODES)[number];

export const SORT_MODES = ["rate", "traded", "name"] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const HEATMAP_VIEWS = ["board", "flow"] as const;
export type HeatmapView = (typeof HEATMAP_VIEWS)[number];

export interface HeatmapSettings {
  range: ColorRange;
  size: SizeMode;
  sort: SortMode;
  view: HeatmapView;
}

export const DEFAULT_SETTINGS: HeatmapSettings = { range: DEFAULT_COLOR_RANGE, size: "traded", sort: "rate", view: "board" };

export const SIZE_LABEL: Record<SizeMode, string> = { traded: "거래대금", equal: "같게" };
export const SORT_LABEL: Record<SortMode, string> = { rate: "등락률", traded: "거래대금", name: "이름" };
export const VIEW_LABEL: Record<HeatmapView, string> = { board: "보드", flow: "흐름 비교" };

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return values.find((value) => value === raw) ?? fallback;
}

export function parseSettings(params: URLSearchParams): HeatmapSettings {
  const range = COLOR_RANGES.find((value) => String(value) === params.get("range")) ?? DEFAULT_SETTINGS.range;
  return {
    range,
    size: oneOf(SIZE_MODES, params.get("size"), DEFAULT_SETTINGS.size),
    sort: oneOf(SORT_MODES, params.get("sort"), DEFAULT_SETTINGS.sort),
    view: oneOf(HEATMAP_VIEWS, params.get("view"), DEFAULT_SETTINGS.view),
  };
}

export function withSettings(params: URLSearchParams, next: HeatmapSettings): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof HeatmapSettings)[]) {
    if (next[key] === DEFAULT_SETTINGS[key]) out.delete(key);
    else out.set(key, String(next[key]));
  }
  return out;
}
