import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { KiwoomCatalogInfo } from "../../api/generated/KiwoomCatalogInfo";
import { layoutTiles, type TileRect } from "./treemap";

const MIN_AREA_SHARE = 0.001;

const knownTraded = (theme: HeatmapBoardTheme): number | null => (theme.summary && theme.summary.tradedMillionWon > 0 ? theme.summary.tradedMillionWon : null);

export function themeTileWeights(themes: readonly HeatmapBoardTheme[]): number[] {
  const known = themes.flatMap((theme) => knownTraded(theme) ?? []);
  if (known.length === 0) return themes.map(() => 1);
  const smallest = Math.min(...known);
  const visibleFloor = known.reduce((sum, traded) => sum + traded, 0) * MIN_AREA_SHARE;
  return themes.map((theme) => Math.max(knownTraded(theme) ?? smallest, visibleFloor));
}

export function arrangeThemes(themes: readonly HeatmapBoardTheme[], width: number, height: number): Map<string, TileRect> {
  const weights = themeTileWeights(themes);
  const tiles = themes.map((theme, i) => ({ key: theme.id, weight: weights[i]! }));
  return new Map(layoutTiles(tiles, width, height).map((rect) => [rect.key, rect]));
}

export function catalogNotice(catalog: KiwoomCatalogInfo | null): { title: string; hint: string | null } | null {
  switch (catalog?.state) {
    case "collecting": return { title: "키움 테마 구성종목을 받는 중입니다", hint: null };
    case "empty": return { title: "키움 테마를 아직 받지 못했습니다", hint: "키움이 연결되면 08:30 이후 받습니다" };
    default: return null;
  }
}

export function catalogFreshness(catalog: KiwoomCatalogInfo | null): string | null {
  return catalog?.date ? `구성종목 ${catalog.date} 기준` : null;
}
