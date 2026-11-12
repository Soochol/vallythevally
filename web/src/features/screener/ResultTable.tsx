import { useEffect, useRef } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { matchedDateText, nextSort, type ResultSort, type ResultSortKey } from "../../lib/screener";
import { SortIcon } from "../icons";

const COLUMNS: readonly { key: ResultSortKey; label: string }[] = [
  { key: "name", label: "종목" },
  { key: "close", label: "종가" },
  { key: "changeRate", label: "등락률" },
  { key: "matchedDate", label: "충족일" },
];
const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" };

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
  return <table ref={table} aria-label={`${screen.name} 결과`} className="w-full table-fixed border-collapse text-s tabular-nums">
    <colgroup><col /><col className="w-[80px]" /><col className="w-[64px]" /><col className="w-[64px]" /></colgroup>
    <thead className="sticky top-0 z-10 bg-bg text-xs text-text-3"><tr>
      {COLUMNS.map(({ key, label }) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.descending ? "descending" : "ascending" : "none"} className="border-y border-line px-2 py-1 font-normal">
        <button type="button" data-chart-control aria-label={`${label} 순으로 정렬`} onClick={() => onSort(nextSort(sort, key))}
          className={`flex h-[var(--size-26)] w-full items-center gap-1 hover:text-text ${key === "name" ? "" : "justify-end"} ${sort.key === key ? "text-text" : ""}`}>
          {label}{sort.key === key && <SortIcon dir={sort.descending ? "down" : "up"} />}
        </button>
      </th>)}
    </tr></thead>
    <tbody>{rows.map((row) => {
      const matched = matchedDateText(screen, row.matchedDate, asOf);
      const active = row.symbol === selected;
      return <tr key={row.symbol} data-code={row.symbol} aria-selected={active} onClick={() => onSelect(row.symbol)}
        className={`h-[var(--size-34)] cursor-pointer border-b border-line/30 hover:bg-surface ${active ? "bg-accent-soft" : ""}`}>
        <td className={`border-l-2 px-2 ${active ? "border-l-accent" : "border-l-transparent"}`}>
          <button type="button" data-chart-control data-result-row aria-current={active || undefined} className="flex w-full min-w-0 items-baseline gap-1 text-left" title={`${row.name} ${row.symbol}`}>
            <b className="min-w-0 truncate font-semibold">{row.name}</b><small className="truncate text-xs text-text-3">{row.symbol}</small>
          </button>
        </td>
        <td className="px-2 text-right" title={`최신 일봉 ${row.latestBarDate}${row.provisional ? " · 당일 요약 잠정" : ""}`}>
          {formatPrice(row.close, false)}{row.provisional && <span aria-label="잠정" className="ml-1 text-warning">*</span>}
          {row.latestBarDate !== asOf && <small className="block text-xs text-text-3">{row.latestBarDate.slice(5)}</small>}
        </td>
        <td className={`px-2 text-right font-semibold ${row.changeRate === null ? "text-text-3" : DIR_CLASS[direction(row.changeRate)]}`}>
          {row.changeRate === null ? "—" : formatPercent(row.changeRate)}
        </td>
        <td title={`첫 봉 조건 일치 ${row.matchedDate}`} className={`px-2 text-right ${matched.current ? "font-semibold text-accent" : "text-text-2"}`}>{matched.text}</td>
      </tr>;
    })}</tbody>
  </table>;
}
