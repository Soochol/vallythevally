import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ranking } from "../../api/generated/Ranking";
import type { RankingRow } from "../../api/generated/RankingRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { LIST_COLUMN_GAP, LIST_EDGE, RateBadge, listRowFill } from "../list/listRow";
import { useFitted } from "../list/useFitted";
import { type Column, RANK_WIDTH, columnsFor, fitRankingColumns, placesOf } from "./rankingColumns";
import { RANKING_NAME } from "./rankingKinds";
import { nextCode } from "./rankingRows";
import { RankingRowMenu, type RankingMenuState } from "./RankingRowMenu";

interface Props {
  ranking: Ranking;
  rows: readonly RankingRow[];
  cursor: SymbolCode | null;
  watched: SymbolCode | null;
  onChoose(row: RankingRow): void;
  onCursor(code: SymbolCode): void;
  onNearEnd(): void;
  scroller: React.RefObject<HTMLDivElement | null>;
}

const NEAR_END_PX = 48;

const columnWidth = (column: Column, last: boolean) => LIST_COLUMN_GAP + column.width + (last ? LIST_EDGE : 0);

function ValueCell({ column, row }: { column: Column; row: RankingRow }) {
  const cell = column.cell(row);
  if (column.rate && cell.text !== "—") return <RateBadge direction={cell.tone === "up" || cell.tone === "down" ? cell.tone : "flat"}>{cell.text}</RateBadge>;
  return <>{cell.text}</>;
}

export function RankingTable({ ranking, rows, cursor, watched, onChoose, onCursor, onNearEnd, scroller }: Props) {
  const all = useMemo(() => columnsFor(ranking), [ranking]);
  const fit = useCallback((chosen: readonly Column[], width: number) => fitRankingColumns(ranking.kind, chosen, width), [ranking.kind]);
  const columns = useFitted(scroller, all, fit);
  const table = useRef<HTMLTableElement>(null);
  const [menu, setMenu] = useState<RankingMenuState | null>(null);
  useEffect(() => {
    if (cursor === null) return;
    [...(table.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])].find((tr) => tr.dataset.code === cursor)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const menuRow = menu && rows.find((row) => row.code === menu.code);
  useEffect(() => { if (menu && !menuRow) setMenu(null); }, [menu, menuRow]);
  const openMenu = (code: SymbolCode, x: number, y: number) => setMenu({ code, kind: "actions", x, y });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const line = cursor === null ? null : [...(table.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])].find((tr) => tr.dataset.code === cursor);
      if (!line || cursor === null) return;
      e.preventDefault();
      const box = line.getBoundingClientRect();
      openMenu(cursor, box.x, box.bottom);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = nextCode(rows, cursor, e.key === "ArrowDown" ? 1 : -1);
      if (next !== null) onCursor(next);
    } else if (e.key === "Enter") {
      const row = rows.find((r) => r.code === cursor);
      if (row) {
        e.preventDefault();
        onChoose(row);
      }
    }
  };
  return (
    <div
      ref={scroller}
      className="rk-scroll"
      tabIndex={0}
      data-chart-control
      aria-label="순위 표"
      aria-keyshortcuts="ArrowUp ArrowDown Enter Shift+F10"
      data-testid="ranking-scroll"
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const box = e.currentTarget;
        if (box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END_PX) onNearEnd();
      }}
    >
      <table ref={table} className="rk-table" aria-label={`${RANKING_NAME[ranking.kind]} 순위`}>
        <colgroup>
          <col style={{ width: LIST_EDGE + RANK_WIDTH }} />
          <col />
          {columns.map((c, i) => <col key={c.key} style={{ width: columnWidth(c, i === columns.length - 1) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="rk-rank">#</th>
            <th scope="col" className="rk-name">종목</th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="rk-num" title={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const places = placesOf(row);
            return (
              <tr
                key={row.code}
                data-testid="ranking-row"
                data-code={row.code}
                data-listed={row.listed}
                aria-selected={row.code === cursor}
                aria-current={row.code === watched ? "true" : undefined}
                className={`rk-line ${listRowFill(row.code === watched)} ${row.listed ? "" : "rk-unlisted"} ${row.code === cursor ? "rk-cursor" : ""}`}
                onClick={() => onChoose(row)}
                onContextMenu={(e) => { e.preventDefault(); openMenu(row.code, e.clientX, e.clientY); }}
              >
                <td className="rk-rank">
                  <span>{row.rank}</span>
                  {places && <small className={`rk-tone-${places.tone}`} data-testid="ranking-places">{places.text}</small>}
                </td>
                <td className="rk-name">
                  <b title={`${row.name} ${row.code}`}>{row.name}</b>
                </td>
                {columns.map((c) => (
                  <td key={c.key} data-col={c.key} className={`rk-num ${c.rate ? "" : `rk-tone-${c.cell(row).tone}`}`}>
                    <ValueCell column={c} row={row} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu && menuRow && <RankingRowMenu row={menuRow} menu={menu} root={table} onOpen={() => onChoose(menuRow)}
        onWatchlists={() => setMenu({ ...menu, kind: "watchlists" })}
        onClose={() => setMenu((current) => current === menu ? null : current)} />}
    </div>
  );
}
