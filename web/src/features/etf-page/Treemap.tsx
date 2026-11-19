import type { EtfHolding } from "../../api/generated/EtfHolding";
import { formatPercent, squarify } from "./etfModel";

const BOX_WIDTH = 160;
const BOX_HEIGHT = 90;
const LABEL_MIN_WIDTH = 14;
const LABEL_MIN_HEIGHT = 10;
const WEIGHT_LABEL_MIN_HEIGHT = 16;

interface TreemapProps {
  holdings: readonly EtfHolding[];
  onPick: (holding: EtfHolding) => void;
}

export function Treemap({ holdings, onPick }: TreemapProps) {
  const byCode = new Map(holdings.map((holding) => [holding.code, holding]));
  const tiles = squarify(holdings.map((holding) => ({ key: holding.code, weight: holding.weightBps })), BOX_WIDTH, BOX_HEIGHT);
  const heaviest = tiles.length === 0 ? 1 : byCode.get(tiles[0]!.key)!.weightBps;
  return (
    <div className="etf-treemap" role="group" aria-label="구성 종목 트리맵">
      {tiles.map((tile) => {
        const holding = byCode.get(tile.key)!;
        const labelled = tile.width >= LABEL_MIN_WIDTH && tile.height >= LABEL_MIN_HEIGHT;
        return (
          <button
            key={tile.key}
            type="button"
            className="etf-tile"
            data-code={holding.code}
            aria-label={`${holding.name} ${formatPercent(holding.weightBps)}`}
            title={`${holding.name} ${formatPercent(holding.weightBps)}`}
            style={{
              left: `${(tile.x / BOX_WIDTH) * 100}%`,
              top: `${(tile.y / BOX_HEIGHT) * 100}%`,
              width: `${(tile.width / BOX_WIDTH) * 100}%`,
              height: `${(tile.height / BOX_HEIGHT) * 100}%`,
              background: `color-mix(in srgb, var(--accent) ${Math.round(14 + (holding.weightBps / heaviest) * 56)}%, var(--raised))`,
            }}
            onClick={() => onPick(holding)}
          >
            {labelled && <span className="etf-tile-name">{holding.name}</span>}
            {labelled && tile.height >= WEIGHT_LABEL_MIN_HEIGHT && <span className="etf-tile-weight">{formatPercent(holding.weightBps)}</span>}
          </button>
        );
      })}
    </div>
  );
}
