import { useMemo, useRef } from "react";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import { tileLabel } from "../../lib/heat/tileLabel";
import { useElementSize } from "../heatmap-page/useElementSize";
import { formatPercent, squarify } from "./etfModel";

const BOX_WIDTH = 160;
const BOX_HEIGHT = 90;
const MIN_MIX_PERCENT = 12;
const MAX_MIX_PERCENT = 34;

interface TreemapProps {
  holdings: readonly EtfHolding[];
  onPick: (holding: EtfHolding) => void;
}

export function Treemap({ holdings, onPick }: TreemapProps) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box);
  const byCode = useMemo(() => new Map(holdings.map((holding) => [holding.code, holding])), [holdings]);
  const tiles = useMemo(() => squarify(holdings.map((holding) => ({ key: holding.code, weight: holding.weightBps })), BOX_WIDTH, BOX_HEIGHT), [holdings]);
  const heaviest = tiles.length === 0 ? 1 : byCode.get(tiles[0]!.key)!.weightBps;
  return (
    <div ref={box} className="etf-treemap" role="group" aria-label="구성 종목 트리맵">
      {tiles.map((tile) => {
        const holding = byCode.get(tile.key)!;
        const label = tileLabel((tile.width / BOX_WIDTH) * size.w, (tile.height / BOX_HEIGHT) * size.h);
        const mix = Math.round(MIN_MIX_PERCENT + (holding.weightBps / heaviest) * (MAX_MIX_PERCENT - MIN_MIX_PERCENT));
        return (
          <button
            key={tile.key}
            type="button"
            className="etf-tile"
            data-code={holding.code}
            data-label={label}
            aria-label={`${holding.name} ${formatPercent(holding.weightBps)}`}
            title={`${holding.name} ${formatPercent(holding.weightBps)}`}
            style={{
              left: `${(tile.x / BOX_WIDTH) * 100}%`,
              top: `${(tile.y / BOX_HEIGHT) * 100}%`,
              width: `${(tile.width / BOX_WIDTH) * 100}%`,
              height: `${(tile.height / BOX_HEIGHT) * 100}%`,
              background: `color-mix(in srgb, var(--accent) ${mix}%, var(--surface))`,
            }}
            onClick={() => onPick(holding)}
          >
            {label === "full" && <span className="etf-tile-name">{holding.name}</span>}
            {label !== "none" && <span className="etf-tile-weight">{formatPercent(holding.weightBps)}</span>}
          </button>
        );
      })}
    </div>
  );
}
