import { useEffect, useRef } from "react";
import type { RankingRow } from "../../api/generated/RankingRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { listRowFill } from "../list/listRow";
import { columnsFor, placesOf } from "./rankingColumns";
import type { Ranking } from "../../api/generated/Ranking";
import { RANKING_NAME } from "./rankingKinds";
import { nextCode } from "./rankingRows";

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

export function RankingTable({ ranking, rows, cursor, watched, onChoose, onCursor, onNearEnd, scroller }: Props) {
  const columns = columnsFor(ranking);
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    if (cursor === null) return;
    [...(table.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])].find((tr) => tr.dataset.code === cursor)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const onKeyDown = (e: React.KeyboardEvent) => {
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
      aria-keyshortcuts="ArrowUp ArrowDown Enter"
      data-testid="ranking-scroll"
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const box = e.currentTarget;
        if (box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END_PX) onNearEnd();
      }}
    >
      <table ref={table} className="rk-table" aria-label={`${RANKING_NAME[ranking.kind]} 순위`}>
        <thead>
          <tr>
            <th scope="col" className="rk-rank">#</th>
            <th scope="col" className="rk-name">종목</th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="rk-num">{c.label}</th>
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
                className={`rk-line ${listRowFill(row.code === watched || row.code === cursor)} ${row.listed ? "" : "rk-unlisted"} ${row.code === cursor ? "rk-cursor" : ""}`}
                onClick={() => onChoose(row)}
              >
                <td className="rk-rank">
                  {row.rank}
                  {places && <small className={`rk-tone-${places.tone}`} data-testid="ranking-places">{places.text}</small>}
                </td>
                <td className="rk-name">
                  <b title={`${row.name} ${row.code}`}>{row.name}</b>
                  <small>{row.code}</small>
                </td>
                {columns.map((c) => {
                  const cell = c.cell(row);
                  return (
                    <td key={c.key} className={`rk-num rk-tone-${cell.tone}`}>
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
