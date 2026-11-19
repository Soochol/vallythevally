import { useMemo, useSyncExternalStore } from "react";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { formatPercent } from "../../lib/format";
import { quoteBook } from "../../stores/realtime";
import { useSendSymbol } from "../pages/sendSymbol";
import { arrange, snapshotRows, type SnapshotRow } from "./arrange";
import { rateFill, rateSide } from "./colors";
import type { HeatmapSection } from "./HeatmapPage";
import type { HeatmapSettings } from "./settings";
import type { TileRect } from "./treemap";

export const MAP_WIDTH = 160;
export const MAP_HEIGHT = 90;
const LABEL_MIN_WIDTH = 9;
const LABEL_MIN_HEIGHT = 6;

interface TileProps {
  row: SnapshotRow;
  rect: TileRect;
  range: HeatmapSettings["range"];
}

function useLiveRate(code: SymbolCode, fallback: number | null): number | null {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  const live = useSyncExternalStore(subscribe, () => quoteBook.get(code));
  return live.quote?.changeRate ?? fallback;
}

function Tile({ row, rect, range }: TileProps) {
  const send = useSendSymbol();
  const rate = useLiveRate(row.code, row.changeRate);
  const text = rate === null ? "–" : formatPercent(rate);
  const labelled = rect.w >= LABEL_MIN_WIDTH && rect.h >= LABEL_MIN_HEIGHT;
  return (
    <button
      type="button"
      className="hm-tile"
      data-code={row.code}
      data-side={rate === null ? "none" : rateSide(rate)}
      aria-label={`${row.name} ${text}`}
      title={`${row.name} ${text}`}
      style={{
        left: `${(rect.x / MAP_WIDTH) * 100}%`,
        top: `${(rect.y / MAP_HEIGHT) * 100}%`,
        width: `${(rect.w / MAP_WIDTH) * 100}%`,
        height: `${(rect.h / MAP_HEIGHT) * 100}%`,
        background: rate === null ? "var(--raised)" : rateFill(rate, range),
      }}
      onClick={() => send({ code: row.code, name: row.name })}
    >
      {labelled && (
        <span className="hm-tile-text">
          <b>{row.name}</b>
          <span>{text}</span>
        </span>
      )}
    </button>
  );
}

interface GroupProps {
  section: HeatmapSection;
  settings: HeatmapSettings;
  names: ReadonlyMap<SymbolCode, string>;
  quotes: readonly Quote[];
  loading: boolean;
}

export function HeatmapGroup({ section, settings, names, quotes, loading }: GroupProps) {
  const rows = useMemo(() => snapshotRows(section.symbols, names, quotes), [section.symbols, names, quotes]);
  const arrangement = useMemo(() => arrange(rows, settings.size, settings.sort, MAP_WIDTH, MAP_HEIGHT), [rows, settings.size, settings.sort]);
  return (
    <section className="hm-group" aria-label={`${section.title} 지도`} data-group={section.key} aria-busy={loading}>
      <header className="hm-group-head">
        <i className="hm-group-dot" style={{ background: section.color }} />
        <h2>{section.title}</h2>
        <span>{rows.length}종목</span>
      </header>
      {rows.length === 0 ? (
        <p className="hm-group-empty">이 그룹에 종목이 없습니다</p>
      ) : (
        <div className="hm-map" role="group" aria-label={`${section.title} 칸`}>
          {arrangement.rows.map((row) => {
            const rect = arrangement.rects.get(row.code);
            return rect ? <Tile key={row.code} row={row} rect={rect} range={settings.range} /> : null;
          })}
        </div>
      )}
    </section>
  );
}
