import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { formatPercent, formatPrice } from "../../lib/format";
import { rateSide } from "../../lib/heat/colors";
import { quoteBook } from "../../stores/realtime";
import { EmptyState } from "../overlay/State";
import { useSendSymbol } from "../pages/sendSymbol";
import { boardRows, sortRows, type SnapshotRow } from "./arrange";
import { DailyCandleStrip } from "./DailyCandleStrip";
import { tradedText } from "./HeatmapGroup";
import type { HeatmapSection } from "./HeatmapPage";
import type { HeatmapSettings } from "./settings";
import { TileMenu, type TileMenuState } from "./TileMenu";
import { addSymbolToThemeNow, addToActiveWatchlist, removeSymbolFromThemeNow, type ThemeChoice } from "./themeQuickEdit";

interface ListProps {
  sections: readonly HeatmapSection[];
  settings: HeatmapSettings;
  names: ReadonlyMap<SymbolCode, string>;
  themes: readonly ThemeChoice[];
  venue: Venue;
  query: string;
}

interface RowProps {
  row: SnapshotRow;
  venue: Venue;
  onSend(row: SnapshotRow): void;
  onMenu(code: SymbolCode, x: number, y: number): void;
}

function useLiveRowQuote(code: SymbolCode, fallbackRate: number | null) {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  const live = useSyncExternalStore(subscribe, () => quoteBook.get(code));
  return {
    price: live.quote?.price ?? null,
    rate: live.quote?.changeRate ?? fallbackRate,
    expected: live.quote?.source === "expected",
  };
}

const ListRow = memo(function ListRow({ row, venue, onSend, onMenu }: RowProps) {
  const { price, rate, expected } = useLiveRowQuote(row.code, row.changeRate);
  const rateText = rate === null ? "–" : formatPercent(rate);
  const priceText = price === null ? "–" : formatPrice(price, false);
  const traded = row.tradedMillionWon === null ? "–" : tradedText(row.tradedMillionWon);
  const side = rate === null ? "none" : rateSide(rate);
  return (
    <li className="hm-list-item">
      <button
        type="button"
        className="hm-list-row"
        data-code={row.code}
        data-side={side}
        aria-label={expected ? `${row.name} ${priceText} ${rateText} 예상체결` : `${row.name} ${priceText} ${rateText}`}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={() => onSend(row)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(row.code, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          onMenu(row.code, box.x, box.bottom);
        }}
      >
        <span className="hm-list-name">{row.name}</span>
        <DailyCandleStrip code={row.code} name={row.name} venue={venue} livePrice={price} />
        <span className="hm-list-price">
          {priceText}
          {expected && <span aria-hidden="true">*</span>}
        </span>
        <span className="hm-list-rate" data-side={side}>
          {rateText}
          {expected && <span aria-hidden="true">*</span>}
        </span>
        <span className="hm-list-traded">{traded}</span>
      </button>
    </li>
  );
});

interface GroupProps {
  section: HeatmapSection;
  rows: readonly SnapshotRow[];
  names: ReadonlyMap<SymbolCode, string>;
  themes: readonly ThemeChoice[];
  venue: Venue;
  collapsed: boolean;
  onToggle(key: string): void;
}

const ListGroup = memo(function ListGroup({ section, rows, names, themes, venue, collapsed, onToggle }: GroupProps) {
  const client = useQueryClient();
  const send = useSendSymbol();
  const root = useRef<HTMLUListElement>(null);
  const [menu, setMenu] = useState<TileMenuState | null>(null);
  const openMenu = useCallback((code: SymbolCode, x: number, y: number) => {
    root.current?.querySelector<HTMLButtonElement>(`.hm-list-row[data-code="${code}"]`)?.focus();
    setMenu({ code, kind: "actions", x, y });
  }, []);
  const sendRow = useCallback((row: SnapshotRow) => send({ code: row.code, name: row.name }), [send]);
  const current = useMemo((): ThemeChoice => ({ id: section.key, name: section.title, symbols: section.symbols }), [section.key, section.title, section.symbols]);
  const weighted = section.theme.summary?.weightedRate ?? null;
  const weightedText = weighted === null ? "–" : formatPercent(weighted);
  const weightedSide = weighted === null ? "none" : rateSide(weighted);
  return (
    <section className="hm-list-group" aria-label={`${section.title} 목록`} data-group={section.key} data-collapsed={collapsed ? "" : undefined}>
      <button type="button" className="hm-list-head" aria-expanded={!collapsed} onClick={() => onToggle(section.key)}>
        <span className="hm-list-title">
          <h2>{section.title}</h2>
          <span className="hm-list-count">{rows.length}</span>
        </span>
        <span className="hm-list-avg" data-side={weightedSide} aria-label={`거래대금 가중 평균 ${weightedText}`}>
          {weightedText}
        </span>
      </button>
      {!collapsed && (
        rows.length === 0 ? (
          <p className="hm-group-empty">이 테마에 종목이 없습니다</p>
        ) : (
          <ul ref={root} className="hm-list-rows">
            {rows.map((row) => (
              <ListRow key={row.code} row={row} venue={venue} onSend={sendRow} onMenu={openMenu} />
            ))}
          </ul>
        )
      )}
      {menu && (
        <TileMenu
          name={names.get(menu.code) ?? menu.code}
          code={menu.code}
          current={current}
          themes={themes}
          menu={menu}
          root={root}
          onSend={() => send({ code: menu.code, name: names.get(menu.code) ?? menu.code })}
          onAddToWatchlist={() => addToActiveWatchlist(menu.code, names.get(menu.code) ?? menu.code)}
          onShowThemes={() => setMenu({ ...menu, kind: "themes" })}
          onBack={() => setMenu({ ...menu, kind: "actions" })}
          onAdd={(target) => void addSymbolToThemeNow(client, target, menu.code, names.get(menu.code) ?? menu.code)}
          onRemove={() => void removeSymbolFromThemeNow(client, current, menu.code, names.get(menu.code) ?? menu.code)}
          onClose={() => setMenu((open) => (open === menu ? null : open))}
        />
      )}
    </section>
  );
});

export function HeatmapList({ sections, settings, names, themes, venue, query }: ListProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => sections.flatMap((section) => {
    const all = sortRows(boardRows(section.theme, names), settings.sort);
    if (!needle) return [{ section, rows: all }];
    if (section.title.toLowerCase().includes(needle)) return [{ section, rows: all }];
    const matched = all.filter((row) => row.name.toLowerCase().includes(needle) || row.code.toLowerCase().includes(needle));
    return matched.length > 0 ? [{ section, rows: matched }] : [];
  }), [sections, names, settings.sort, needle]);

  if (needle && visible.length === 0) {
    return <EmptyState title="조건에 맞는 종목이 없습니다" />;
  }
  return (
    <div className="hm-list-groups">
      {visible.map(({ section, rows }) => (
        <ListGroup
          key={section.key}
          section={section}
          rows={rows}
          names={names}
          themes={themes}
          venue={venue}
          collapsed={collapsed.has(section.key)}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}
