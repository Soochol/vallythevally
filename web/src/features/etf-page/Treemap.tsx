import { useMemo, useRef } from "react";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import type { EtfHolding } from "../../api/generated/EtfHolding";
import { tileLabel } from "../../lib/heat/tileLabel";
import { useElementSize } from "../heatmap-page/useElementSize";
import { type TreemapLens, formatPercent, maAlignedCount, squarify } from "./etfModel";

const BOX_WIDTH = 160;
const BOX_HEIGHT = 90;
const MIN_MIX_PERCENT = 5;
const MAX_MIX_PERCENT = 24;

function tileFill(
  holding: EtfHolding,
  heaviest: number,
  lens: TreemapLens,
  changeRow: EtfChangeRow | undefined,
): string {
  if (lens === "ma") {
    const { ma20, ma60, ma120 } = holding.ma;
    if (ma20 === null && ma60 === null && ma120 === null) return "var(--raised)";
    const aligned = maAlignedCount(holding.ma);
    if (aligned === 3) return "color-mix(in srgb, var(--up) 30%, var(--surface))";
    if (aligned === 2) return "color-mix(in srgb, var(--up) 18%, var(--surface))";
    if (aligned === 1) return "color-mix(in srgb, var(--warning) 20%, var(--surface))";
    return "color-mix(in srgb, var(--down) 26%, var(--surface))";
  }
  if (lens === "flow") {
    if (changeRow === undefined) return "var(--raised)";
    if (changeRow.kind === "added") return "color-mix(in srgb, var(--accent) 30%, var(--surface))";
    if (changeRow.kind === "increased") return "color-mix(in srgb, var(--up) 28%, var(--surface))";
    if (changeRow.kind === "decreased" || changeRow.kind === "removed") {
      return "color-mix(in srgb, var(--down) 28%, var(--surface))";
    }
    return "var(--raised)";
  }
  const mix = Math.round(MIN_MIX_PERCENT + (holding.weightBps / heaviest) * (MAX_MIX_PERCENT - MIN_MIX_PERCENT));
  return `color-mix(in srgb, var(--accent) ${mix}%, var(--surface))`;
}

interface TreemapProps {
  holdings: readonly EtfHolding[];
  lens: TreemapLens;
  changesByCode: ReadonlyMap<string, EtfChangeRow>;
  hoveredCode: string | null;
  onHover: (code: string | null) => void;
  onPick: (holding: EtfHolding) => void;
}

export function Treemap({ holdings, lens, changesByCode, hoveredCode, onHover, onPick }: TreemapProps) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box);
  const byCode = useMemo(() => new Map(holdings.map((holding) => [holding.code, holding])), [holdings]);
  const tiles = useMemo(
    () => squarify(holdings.map((holding) => ({ key: holding.code, weight: holding.weightBps })), BOX_WIDTH, BOX_HEIGHT),
    [holdings],
  );
  const heaviest = tiles.length === 0 ? 1 : byCode.get(tiles[0]!.key)!.weightBps;
  return (
    <div ref={box} className="etf-treemap" role="group" aria-label="구성 종목 트리맵">
      {tiles.map((tile) => {
        const holding = byCode.get(tile.key)!;
        const label = tileLabel((tile.width / BOX_WIDTH) * size.w, (tile.height / BOX_HEIGHT) * size.h);
        const background = tileFill(holding, heaviest, lens, changesByCode.get(holding.code));
        return (
          <button
            key={tile.key}
            type="button"
            className="etf-tile"
            data-code={holding.code}
            data-label={label}
            data-lens={lens}
            data-highlighted={hoveredCode === holding.code ? "true" : undefined}
            aria-label={`${holding.name} ${formatPercent(holding.weightBps)}`}
            title={`${holding.name} ${formatPercent(holding.weightBps)}`}
            style={{
              left: `${(tile.x / BOX_WIDTH) * 100}%`,
              top: `${(tile.y / BOX_HEIGHT) * 100}%`,
              width: `${(tile.width / BOX_WIDTH) * 100}%`,
              height: `${(tile.height / BOX_HEIGHT) * 100}%`,
              background,
            }}
            onMouseEnter={() => onHover(holding.code)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(holding.code)}
            onBlur={() => onHover(null)}
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
