export interface SectorTileInput {
  code: string;
  tradeValueEok: number;
}

export interface SectorTileRect {
  code: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  code: string;
  area: number;
}

const worstRatio = (row: readonly Placed[], side: number): number => {
  const thickness = row.reduce((total, tile) => total + tile.area, 0) / side;
  return row.reduce((worst, tile) => {
    const length = tile.area / thickness;
    return Math.max(worst, length / thickness, thickness / length);
  }, 0);
};

export function layoutSectorMap(sectors: readonly SectorTileInput[], width: number, height: number): SectorTileRect[] {
  const sized = sectors.filter((sector) => sector.tradeValueEok > 0).toSorted((a, b) => b.tradeValueEok - a.tradeValueEok);
  if (sized.length === 0 || width <= 0 || height <= 0) return [];
  const total = sized.reduce((sum, sector) => sum + sector.tradeValueEok, 0);
  const placed: Placed[] = sized.map((sector) => ({ code: sector.code, area: (sector.tradeValueEok / total) * width * height }));
  const tiles: SectorTileRect[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let index = 0;
  while (index < placed.length) {
    const horizontal = w >= h;
    const side = horizontal ? h : w;
    let row = [placed[index]!];
    let next = index + 1;
    while (next < placed.length && worstRatio([...row, placed[next]!], side) <= worstRatio(row, side)) {
      row = [...row, placed[next]!];
      next += 1;
    }
    const sum = row.reduce((total, tile) => total + tile.area, 0);
    const thickness = next === placed.length ? (horizontal ? w : h) : sum / side;
    let offset = 0;
    for (const tile of row) {
      const length = (tile.area / sum) * side;
      tiles.push(horizontal ? { code: tile.code, x, y: y + offset, w: thickness, h: length } : { code: tile.code, x: x + offset, y, w: length, h: thickness });
      offset += length;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    index = next;
  }
  return tiles;
}

export const SECTOR_RATE_RANGE = 3;

export function sectorFill(changeRate: number): string {
  if (changeRate === 0) return "var(--raised)";
  const side = changeRate > 0 ? "up" : "down";
  const mix = Math.round(8 + Math.min(Math.abs(changeRate) / SECTOR_RATE_RANGE, 1) * 74);
  return `color-mix(in srgb, var(--${side}) ${mix}%, var(--surface))`;
}
