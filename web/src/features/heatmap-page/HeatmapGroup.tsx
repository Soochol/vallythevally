import { useMemo, useSyncExternalStore } from "react";
import type { HeatmapThemeSummary } from "../../api/generated/HeatmapThemeSummary";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { formatPercent, formatWonAmount } from "../../lib/format";
import { quoteBook } from "../../stores/realtime";
import { useSendSymbol } from "../pages/sendSymbol";
import { arrange, boardRows, type SnapshotRow } from "./arrange";
import { rateFill, rateSide } from "./colors";
import type { HeatmapSection } from "./HeatmapPage";
import type { HeatmapSettings } from "./settings";
import type { TileRect } from "./treemap";

export const MAP_WIDTH = 160;
export const MAP_HEIGHT = 90;
const LABEL_MIN_WIDTH = 9;
const LABEL_MIN_HEIGHT = 6;

const MILLION_WON = 1_000_000;

export const tradedText = (millionWon: number) => formatWonAmount(millionWon * MILLION_WON);

interface TileProps {
  row: SnapshotRow;
  rect: TileRect;
  range: HeatmapSettings["range"];
  themeName: string;
  themeTraded: number;
}

function tileDetail(row: SnapshotRow, text: string, themeName: string, themeTraded: number): string {
  const traded = row.tradedMillionWon === null ? "거래대금 –" : `거래대금 ${tradedText(row.tradedMillionWon)}`;
  const share = row.tradedMillionWon === null || themeTraded <= 0 ? "" : ` · ${themeName} 안 비중 ${((row.tradedMillionWon / themeTraded) * 100).toFixed(1)}%`;
  return `${row.name} ${text}\n${row.code} · ${traded}${share}`;
}

function useLiveRate(code: SymbolCode, fallback: number | null): number | null {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  const live = useSyncExternalStore(subscribe, () => quoteBook.get(code));
  return live.quote?.changeRate ?? fallback;
}

function Tile({ row, rect, range, themeName, themeTraded }: TileProps) {
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
      title={tileDetail(row, text, themeName, themeTraded)}
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
}

function Breadth({ summary }: { summary: HeatmapThemeSummary }) {
  const total = summary.rising + summary.flat + summary.falling;
  const width = (n: number) => `${(n / total) * 100}%`;
  return (
    <span className="hm-breadth">
      <span className="hm-breadth-bar" aria-hidden="true">
        <i data-side="up" style={{ width: width(summary.rising) }} />
        <i data-side="flat" style={{ width: width(summary.flat) }} />
        <i data-side="down" style={{ width: width(summary.falling) }} />
      </span>
      <span>
        <span data-side="up">상승 {summary.rising}</span> · 보합 {summary.flat} · <span data-side="down">하락 {summary.falling}</span>
      </span>
    </span>
  );
}

function SummaryLine({ summary, names }: { summary: HeatmapThemeSummary; names: ReadonlyMap<SymbolCode, string> }) {
  return (
    <p className="hm-summary" aria-label="테마 요약">
      <span>거래대금 <b>{tradedText(summary.tradedMillionWon)}</b></span>
      <Breadth summary={summary} />
      <span>대장주 <b>{names.get(summary.leader) ?? summary.leader}</b></span>
    </p>
  );
}

export function HeatmapGroup({ section, settings, names }: GroupProps) {
  const { theme } = section;
  const rows = useMemo(() => boardRows(theme, names), [theme, names]);
  const arrangement = useMemo(() => arrange(rows, settings.size, settings.sort, MAP_WIDTH, MAP_HEIGHT), [rows, settings.size, settings.sort]);
  const weighted = theme.summary?.weightedRate ?? null;
  const missingNames = theme.missing.map((code) => names.get(code) ?? code);
  return (
    <section className="hm-group" aria-label={`${section.title} 지도`} data-group={section.key}>
      <header className="hm-group-head">
        <div className="hm-group-title">
          <i className="hm-group-dot" style={{ background: section.color }} />
          <h2>{section.title}</h2>
          <span>{rows.length}종목</span>
        </div>
        <div className="hm-group-rate" data-side={weighted === null ? "none" : rateSide(weighted)} aria-label={`거래대금 가중 평균 ${weighted === null ? "–" : formatPercent(weighted)}`}>
          {weighted === null ? "–" : formatPercent(weighted)}
          <small>거래대금 가중 평균</small>
        </div>
        {theme.summary && <SummaryLine summary={theme.summary} names={names} />}
      </header>
      {rows.length === 0 ? (
        <p className="hm-group-empty">이 테마에 종목이 없습니다</p>
      ) : (
        <div className="hm-map" role="group" aria-label={`${section.title} 칸`}>
          {arrangement.rows.map((row) => {
            const rect = arrangement.rects.get(row.code);
            return rect ? <Tile key={row.code} row={row} rect={rect} range={settings.range} themeName={section.title} themeTraded={theme.summary?.tradedMillionWon ?? 0} /> : null;
          })}
        </div>
      )}
      {missingNames.length > 0 && <p className="hm-group-note" role="note">시세를 받지 못해 요약에서 뺀 종목: {missingNames.join(", ")}</p>}
    </section>
  );
}
