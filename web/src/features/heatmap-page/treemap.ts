export interface TileInput {
  key: string;
  weight: number;
}

export interface TileRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed extends TileInput {
  area: number;
}

function worstRatio(row: readonly Placed[], side: number): number {
  const sum = row.reduce((total, tile) => total + tile.area, 0);
  const thickness = sum / side;
  return row.reduce((worst, tile) => {
    const length = tile.area / thickness;
    return Math.max(worst, length / thickness, thickness / length);
  }, 0);
}

export function layoutTiles(tiles: readonly TileInput[], width: number, height: number): TileRect[] {
  if (tiles.length === 0 || width <= 0 || height <= 0) return [];
  const total = tiles.reduce((sum, tile) => sum + tile.weight, 0);
  const placed: Placed[] = tiles.map((tile) => ({ ...tile, area: (tile.weight / total) * width * height }));
  const out: TileRect[] = [];
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
      const length = next === placed.length || row.length === 1 ? (tile.area / sum) * side : tile.area / thickness;
      out.push(horizontal ? { key: tile.key, x, y: y + offset, w: thickness, h: length } : { key: tile.key, x: x + offset, y, w: length, h: thickness });
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
  return out;
}
