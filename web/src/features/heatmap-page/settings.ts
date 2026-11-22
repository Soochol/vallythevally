import type { HeatmapSource } from "../../api/generated/HeatmapSource";
import type { HeatmapThemeOrder } from "../../api/generated/HeatmapThemeOrder";
import { COLOR_RANGES, type ColorRange, DEFAULT_COLOR_RANGE } from "./colors";

export const SIZE_MODES = ["traded", "equal"] as const;
export type SizeMode = (typeof SIZE_MODES)[number];

export const SORT_MODES = ["rate", "traded", "name"] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const THEME_ORDERS = ["rate", "custom", "traded"] as const satisfies readonly HeatmapThemeOrder[];

export const HEATMAP_VIEWS = ["board", "flow"] as const;
export type HeatmapView = (typeof HEATMAP_VIEWS)[number];

export const HEATMAP_SOURCES = ["mine", "kiwoom"] as const satisfies readonly HeatmapSource[];

export const KIWOOM_THEME_PREFIX = "kiwoom-";

export interface HeatmapSettings {
  range: ColorRange;
  size: SizeMode;
  sort: SortMode;
  view: HeatmapView;
  order: HeatmapThemeOrder;
  source: HeatmapSource;
  theme: string | null;
}

export const DEFAULT_SETTINGS: HeatmapSettings = { range: DEFAULT_COLOR_RANGE, size: "traded", sort: "rate", view: "board", order: "rate", source: "mine", theme: null };

export const SIZE_LABEL: Record<SizeMode, string> = { traded: "거래대금", equal: "같게" };
export const SORT_LABEL: Record<SortMode, string> = { rate: "등락률", traded: "거래대금", name: "이름" };
export const ORDER_LABEL: Record<HeatmapThemeOrder, string> = { rate: "가중 평균 등락률", custom: "내 순서", traded: "거래대금" };
export const SOURCE_LABEL: Record<HeatmapSource, string> = { mine: "내 테마", kiwoom: "키움 테마" };
export const VIEW_LABEL: Record<HeatmapView, string> = { board: "보드", flow: "흐름 비교" };

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return values.find((value) => value === raw) ?? fallback;
}

function kiwoomThemeOf(raw: string | null): string | null {
  return raw !== null && raw.startsWith(KIWOOM_THEME_PREFIX) && raw.length > KIWOOM_THEME_PREFIX.length ? raw : null;
}

export function parseSettings(params: URLSearchParams): HeatmapSettings {
  const range = COLOR_RANGES.find((value) => String(value) === params.get("range")) ?? DEFAULT_SETTINGS.range;
  const source = oneOf(HEATMAP_SOURCES, params.get("source"), DEFAULT_SETTINGS.source);
  return {
    range,
    size: oneOf(SIZE_MODES, params.get("size"), DEFAULT_SETTINGS.size),
    sort: oneOf(SORT_MODES, params.get("sort"), DEFAULT_SETTINGS.sort),
    view: oneOf(HEATMAP_VIEWS, params.get("view"), DEFAULT_SETTINGS.view),
    order: oneOf(THEME_ORDERS, params.get("order"), DEFAULT_SETTINGS.order),
    source,
    theme: source === "kiwoom" ? kiwoomThemeOf(params.get("theme")) : null,
  };
}

export function withSettings(params: URLSearchParams, next: HeatmapSettings): URLSearchParams {
  const out = new URLSearchParams(params);
  const effective = next.source === "kiwoom" ? next : { ...next, theme: null };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof HeatmapSettings)[]) {
    if (effective[key] === DEFAULT_SETTINGS[key]) out.delete(key);
    else out.set(key, String(effective[key]));
  }
  return out;
}
