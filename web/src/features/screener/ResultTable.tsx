import { useEffect, useRef } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { nextSort, type ResultSort, type ResultSortKey } from "../../lib/screener";
import { WATCH_COLUMN_LABEL } from "../../lib/watchlist";
import { SortIcon } from "../icons";
import { LIST_COLUMN_GAP, LIST_EDGE, LIST_HEAD, LIST_PRICE_WIDTH, LIST_RATE_WIDTH, LIST_ROW_HEIGHT, LIST_ROW_HOVER, PriceText, RateBadge, SymbolName, listRowEdge, listRowFill } from "../list/listRow";

const COLUMNS: readonly { key: ResultSortKey; label: string }[] = [
  { key: "name", label: "종목" },
  { key: "close", label: WATCH_COLUMN_LABEL.price },
  { key: "changeRate", label: "등락률" },
];
const CELL_AFTER_FIRST = "pl-1";

interface Props {
  screen: Screen;
  asOf: ScreenerResult["asOf"];
  rows: readonly ScreenerRow[];
  selected: SymbolCode | null;
  sort: ResultSort;
  onSort(sort: ResultSort): void;
  onSelect(code: SymbolCode): void;
}

export function ResultTable({ screen, asOf, rows, selected, sort, onSort, onSelect }: Props) {
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const root = table.current;
    const row = root && [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) => row.dataset.code === selected);
    if (!root || !row) return;
    row.scrollIntoView({ block: "nearest" });
    if (document.activeElement?.closest("tbody") === root.tBodies[0]) row.querySelector("button")?.focus({ preventScroll: true });
  }, [selected, rows]);
  return <table ref={table} aria-label={`${screen.name} 결과`} className="w-full table-fixed border-collapse text-m tabular-nums">
    <colgroup><col /><col style={{ width: LIST_PRICE_WIDTH + LIST_COLUMN_GAP }} /><col style={{ width: LIST_RATE_WIDTH + LIST_COLUMN_GAP + LIST_EDGE }} /></colgroup>
    <thead className={`sticky top-0 z-10 bg-bg ${LIST_HEAD}`}><tr>
      {COLUMNS.map(({ key, label }) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.descending ? "descending" : "ascending" : "none"} className={`py-1 font-normal ${key === "name" ? "pl-3" : key === "close" ? CELL_AFTER_FIRST : `${CELL_AFTER_FIRST} pr-3`}`}>
        <button type="button" data-chart-control aria-label={`${label} 순으로 정렬`} onClick={() => onSort(nextSort(sort, key))}
          className={`flex h-[var(--size-26)] w-full items-center gap-1 hover:text-text ${key === "name" ? "" : "justify-end"} ${sort.key === key ? "text-text" : ""}`}>
          {label}{sort.key === key && <SortIcon dir={sort.descending ? "down" : "up"} />}
        </button>
      </th>)}
    </tr></thead>
    <tbody>{rows.map((row) => {
      const active = row.symbol === selected;
      return <tr key={row.symbol} data-code={row.symbol} aria-selected={active} onClick={() => onSelect(row.symbol)}
        className={`${LIST_ROW_HEIGHT} cursor-pointer ${LIST_ROW_HOVER} ${listRowFill(active)}`}>
        <td className={`${listRowEdge(active)} pl-2.5`}>
          <button type="button" data-chart-control data-result-row aria-current={active || undefined} className="block w-full min-w-0 text-left">
            <SymbolName name={row.name} code={row.symbol} />
          </button>
        </td>
        <td className={CELL_AFTER_FIRST} title={`최신 일봉 ${row.latestBarDate}${row.provisional ? " · 당일 요약 잠정" : ""}`}>
          <PriceText>{formatPrice(row.close, false)}{row.provisional && <span aria-label="잠정" className="ml-1 text-warning">*</span>}</PriceText>
          {row.latestBarDate !== asOf && <small className="block text-right text-xs text-text-3">{row.latestBarDate.slice(5)}</small>}
        </td>
        <td className={`${CELL_AFTER_FIRST} pr-3`}>
          {row.changeRate === null ? <span className="block text-right text-text-3">—</span> : <RateBadge direction={direction(row.changeRate)}>{formatPercent(row.changeRate)}</RateBadge>}
        </td>
      </tr>;
    })}</tbody>
  </table>;
}
