import { useQueryClient } from "@tanstack/react-query";
import { type FocusEvent, memo, type PointerEvent, type ReactNode, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HeatmapThemeSummary } from "../../api/generated/HeatmapThemeSummary";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { formatPercent, formatPrice, formatWonAmount } from "../../lib/format";
import { needsStrongInk, rateFill, rateSide } from "../../lib/heat/colors";
import { nameLines, tileLabel, type TileLabel } from "../../lib/heat/tileLabel";
import { quoteBook } from "../../stores/realtime";
import { useSendSymbol } from "../pages/sendSymbol";
import { arrange, boardRows, type SnapshotRow } from "./arrange";
import type { HeatmapSection } from "./HeatmapPage";
import type { HeatmapSettings } from "./settings";
import { TileMenu, type TileMenuState } from "./TileMenu";
import { useElementSize } from "./useElementSize";
import { addSymbolToThemeNow, addToActiveWatchlist, removeSymbolFromThemeNow, type ThemeChoice } from "./themeQuickEdit";
import type { TileRect } from "./treemap";

export const MAP_WIDTH = 160;
export const MAP_HEIGHT = 90;

const MILLION_WON = 1_000_000;

export const tradedText = (millionWon: number) => formatWonAmount(millionWon * MILLION_WON);

interface TileProps {
  row: SnapshotRow;
  rect: TileRect;
  range: HeatmapSettings["range"];
  label: TileLabel;
  lines: 1 | 2;
  editable: boolean;
  onMenu(code: SymbolCode, x: number, y: number): void;
  onSend(row: SnapshotRow): void;
}

interface LiveRate {
  readonly rate: number | null;
  readonly expected: boolean;
}

function useLiveRate(code: SymbolCode, fallback: number | null): LiveRate {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  const live = useSyncExternalStore(subscribe, () => quoteBook.get(code));
  return {
    rate: live.quote?.changeRate ?? fallback,
    expected: live.quote?.source === "expected",
  };
}

const Tile = memo(function Tile({ row, rect, range, label, lines, editable, onMenu, onSend }: TileProps) {
  const { rate, expected } = useLiveRate(row.code, row.changeRate);
  const text = rate === null ? "–" : formatPercent(rate);
  return (
    <button
      type="button"
      className="hm-tile"
      data-code={row.code}
      data-side={rate === null ? "none" : rateSide(rate)}
      data-strong={rate !== null && needsStrongInk(rate, range)}
      aria-label={expected ? `${row.name} ${text} 예상체결` : `${row.name} ${text}`}
      aria-haspopup={editable ? "menu" : undefined}
      aria-keyshortcuts={editable ? "Shift+F10" : undefined}
      style={{
        left: `${(rect.x / MAP_WIDTH) * 100}%`,
        top: `${(rect.y / MAP_HEIGHT) * 100}%`,
        width: `${(rect.w / MAP_WIDTH) * 100}%`,
        height: `${(rect.h / MAP_HEIGHT) * 100}%`,
        background: rate === null ? "var(--raised)" : rateFill(rate, range),
        ["--name-lines" as string]: lines,
      }}
      onClick={() => onSend(row)}
      onContextMenu={(event) => {
        if (!editable) return;
        event.preventDefault();
        onMenu(row.code, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (!editable || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onMenu(row.code, box.x, box.bottom);
      }}
    >
      {label !== "none" && (
        <span className="hm-tile-text">
          {label === "full" && <b className="hm-tile-name">{row.name}</b>}
          {expected ? (
            <span className="hm-tile-rate" data-expected="true">
              <span className="hm-tile-rate-value">{text}</span>
              <span className="hm-tile-star" aria-hidden="true">*</span>
            </span>
          ) : (
            <span className="hm-tile-rate">{text}</span>
          )}
        </span>
      )}
    </button>
  );
});

interface CardProps {
  row: SnapshotRow;
  rect: TileRect;
  themeName: string;
  themeTraded: number;
}

function TileCard({ row, rect, themeName, themeTraded }: CardProps) {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(row.code, listener), [row.code]);
  const quote = useSyncExternalStore(subscribe, () => quoteBook.get(row.code)).quote;
  const rate = quote?.changeRate ?? row.changeRate;
  const expected = quote?.source === "expected";
  const traded = row.tradedMillionWon === null ? "–" : tradedText(row.tradedMillionWon);
  const share = row.tradedMillionWon === null || themeTraded <= 0 ? null : `${((row.tradedMillionWon / themeTraded) * 100).toFixed(1)}%`;
  const right = rect.x + rect.w / 2 > MAP_WIDTH / 2;
  const below = rect.y + rect.h / 2 < MAP_HEIGHT / 2;
  return (
    <div
      role="tooltip"
      className="hm-tile-card"
      data-flip-x={right}
      data-flip-y={!below}
      style={{ left: `${((right ? rect.x : rect.x + rect.w) / MAP_WIDTH) * 100}%`, top: `${((below ? rect.y + rect.h : rect.y) / MAP_HEIGHT) * 100}%` }}
    >
      <strong>{row.name}</strong>
      <span>{row.code}</span>
      <dl>
        <dt>현재가</dt>
        <dd>
          {quote ? formatPrice(quote.price, false) : "–"}
          {expected && <span aria-hidden="true">*</span>}
        </dd>
        <dt>등락률</dt>
        <dd data-side={rate === null ? "none" : rateSide(rate)}>{rate === null ? "–" : formatPercent(rate)}</dd>
        <dt>거래대금</dt>
        <dd>{traded}</dd>
        {share && (
          <>
            <dt>{themeName} 안 비중</dt>
            <dd>{share}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

interface GroupProps {
  section: HeatmapSection;
  settings: HeatmapSettings;
  names: ReadonlyMap<SymbolCode, string>;
  themes: readonly ThemeChoice[];
  editable: boolean;
  headAction?: ReactNode;
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
      <span className="hm-leader">대장주 <b>{names.get(summary.leader) ?? summary.leader}</b></span>
    </p>
  );
}

export const HeatmapGroup = memo(function HeatmapGroup({ section, settings, names, themes, editable, headAction }: GroupProps) {
  const { theme } = section;
  const client = useQueryClient();
  const send = useSendSymbol();
  const map = useRef<HTMLDivElement>(null);
  const size = useElementSize(map);
  const [menu, setMenu] = useState<TileMenuState | null>(null);
  const [card, setCard] = useState<SymbolCode | null>(null);
  const openMenu = useCallback((code: SymbolCode, x: number, y: number) => {
    map.current?.querySelector<HTMLButtonElement>(`.hm-tile[data-code="${code}"]`)?.focus();
    setCard(null);
    setMenu({ code, kind: "actions", x, y });
  }, []);
  const sendRow = useCallback((row: SnapshotRow) => send({ code: row.code, name: row.name }), [send]);
  const current = useMemo((): ThemeChoice => ({ id: section.key, name: section.title, symbols: section.symbols }), [section.key, section.title, section.symbols]);
  const rows = useMemo(() => boardRows(theme, names), [theme, names]);
  const arrangement = useMemo(() => arrange(rows, settings.size, settings.sort, MAP_WIDTH, MAP_HEIGHT), [rows, settings.size, settings.sort]);
  const weighted = theme.summary?.weightedRate ?? null;
  const missingNames = theme.missing.map((code) => names.get(code) ?? code);
  const themeTraded = theme.summary?.tradedMillionWon ?? 0;
  const showCard = (event: { target: EventTarget }) => {
    const code = (event.target as HTMLElement).closest<HTMLElement>(".hm-tile")?.dataset.code;
    setCard((code as SymbolCode | undefined) ?? null);
  };
  const hideCard = (event: PointerEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && map.current?.contains(event.relatedTarget)) return;
    setCard(null);
  };
  const cardRow = card === null ? undefined : arrangement.rows.find((row) => row.code === card);
  const cardRect = card === null ? undefined : arrangement.rects.get(card);
  return (
    <section className="hm-group" aria-label={`${section.title} 지도`} data-group={section.key}>
      <header className="hm-group-head">
        <div className="hm-group-title">
          <i className="hm-group-dot" style={{ background: section.color }} />
          <h2>{section.title}</h2>
          <span className="hm-group-count">{rows.length}종목</span>
        </div>
        <div className="hm-group-rate" data-side={weighted === null ? "none" : rateSide(weighted)} aria-label={`거래대금 가중 평균 ${weighted === null ? "–" : formatPercent(weighted)}`}>
          {weighted === null ? "–" : formatPercent(weighted)}
        </div>
        {theme.summary && <SummaryLine summary={theme.summary} names={names} />}
        {headAction && <div className="hm-group-actions">{headAction}</div>}
      </header>
      {rows.length === 0 ? (
        <p className="hm-group-empty">이 테마에 종목이 없습니다</p>
      ) : (
        <div className="hm-map-frame">
          <div
            ref={map}
            className="hm-map"
            role="group"
            aria-label={`${section.title} 칸`}
            onPointerOver={showCard}
            onPointerOut={hideCard}
            onFocus={showCard}
            onBlur={hideCard}
            onKeyDown={(event) => event.key === "Escape" && setCard(null)}
          >
            {arrangement.rows.map((row) => {
              const rect = arrangement.rects.get(row.code);
              if (!rect) return null;
              const px = { w: (rect.w / MAP_WIDTH) * size.w, h: (rect.h / MAP_HEIGHT) * size.h };
              return <Tile key={row.code} row={row} rect={rect} range={settings.range} label={tileLabel(px.w, px.h)} lines={nameLines(px.h)} editable={editable} onMenu={openMenu} onSend={sendRow} />;
            })}
          </div>
          {cardRow && cardRect && !menu && <TileCard row={cardRow} rect={cardRect} themeName={section.title} themeTraded={themeTraded} />}
        </div>
      )}
      {menu && (
        <TileMenu
          name={names.get(menu.code) ?? menu.code}
          code={menu.code}
          current={current}
          themes={themes}
          menu={menu}
          root={map}
          onSend={() => send({ code: menu.code, name: names.get(menu.code) ?? menu.code })}
          onAddToWatchlist={() => addToActiveWatchlist(menu.code, names.get(menu.code) ?? menu.code)}
          onShowThemes={() => setMenu({ ...menu, kind: "themes" })}
          onBack={() => setMenu({ ...menu, kind: "actions" })}
          onAdd={(target) => void addSymbolToThemeNow(client, target, menu.code, names.get(menu.code) ?? menu.code)}
          onRemove={() => void removeSymbolFromThemeNow(client, current, menu.code, names.get(menu.code) ?? menu.code)}
          onClose={() => setMenu((open) => (open === menu ? null : open))}
        />
      )}
      {missingNames.length > 0 && <p className="hm-group-note" role="note">시세를 받지 못해 요약에서 뺀 종목: {missingNames.join(", ")}</p>}
    </section>
  );
});
