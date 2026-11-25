import { useEffect, useRef, useState } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { direction, formatPercent, formatPrice, MINUS } from "../../lib/format";
import { nextSort, type ResultSort, type ResultSortKey } from "../../lib/screener";
import { WATCH_COLUMN_LABEL } from "../../lib/watchlist";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { addRowToCompare } from "../list/symbolRowMenu";
import { ClockIcon, SortIcon } from "../icons";
import { ResultRowMenu, type ResultMenuState } from "./ResultRowMenu";
import { LIST_COLUMN_GAP, LIST_EDGE, LIST_HEAD, LIST_PRICE_WIDTH, LIST_RATE_WIDTH, LIST_ROW_HEIGHT, PriceText, RateBadge, SymbolName, listRowFill } from "../list/listRow";

const BASE_COLUMNS: readonly { key: ResultSortKey; label: string }[] = [
  { key: "name", label: "종목" },
  { key: "close", label: WATCH_COLUMN_LABEL.price },
  { key: "changeRate", label: "등락률" },
];
const MICRO_AMOUNT_WIDTH = 72;
const MICRO_COUNT_WIDTH = 42;
const CELL_AFTER_FIRST = "pl-1";
export const RESULT_KEYS_HINT = "↑↓ 결과 이동 · ↵ 칸에 열기";

function formatSignedMillion(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${prefix}${Math.abs(value).toLocaleString("ko-KR")}백만`;
}

function amountTone(value: number): string {
  const dir = direction(value);
  return dir === "up" ? "text-rise" : dir === "down" ? "text-fall" : "text-text-2";
}

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
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [menu, setMenu] = useState<ResultMenuState | null>(null);
  const openMenu = (code: SymbolCode, x: number, y: number) => {
    table.current?.querySelector<HTMLButtonElement>(`tr[data-code="${code}"] button`)?.focus();
    setMenu({ code, kind: "actions", x, y });
  };
  const cellId = useSelectionStore((s) => s.activeCell);
  const cell = useCell(cellId);
  const menuRow = menu && rows.find((row) => row.symbol === menu.code);
  useEffect(() => { if (menu && !menuRow) setMenu(null); }, [menu, menuRow]);
  useEffect(() => {
    const root = table.current;
    const row = root && [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) => row.dataset.code === selected);
    if (!root || !row) return;
    row.scrollIntoView({ block: "nearest" });
    if (document.activeElement?.closest("tbody") === root.tBodies[0]) row.querySelector("button")?.focus({ preventScroll: true });
  }, [selected, rows]);
  const showProgram = rows.some((row) => row.programNetMillionWon !== undefined);
  const showWhale = rows.some((row) => row.whaleNetMillionWon !== undefined);
  const showVi = rows.some((row) => row.viCount !== undefined);
  const columns: { key: ResultSortKey; label: string }[] = [
    ...BASE_COLUMNS,
    ...(showProgram ? [{ key: "programNetMillionWon" as const, label: "프로그램" }] : []),
    ...(showWhale ? [{ key: "whaleNetMillionWon" as const, label: "고래" }] : []),
    ...(showVi ? [{ key: "viCount" as const, label: "VI" }] : []),
  ];
  const lastIndex = columns.length - 1;
  return <>
  <table ref={table} aria-label={`${screen.name} 결과`} className="w-full table-fixed border-collapse text-m tabular-nums">
    <colgroup>
      <col />
      <col style={{ width: LIST_PRICE_WIDTH + LIST_COLUMN_GAP }} />
      <col style={{ width: LIST_RATE_WIDTH + LIST_COLUMN_GAP + (lastIndex === 2 ? LIST_EDGE : 0) }} />
      {showProgram && <col style={{ width: MICRO_AMOUNT_WIDTH + LIST_COLUMN_GAP + (!showWhale && !showVi ? LIST_EDGE : 0) }} />}
      {showWhale && <col style={{ width: MICRO_AMOUNT_WIDTH + LIST_COLUMN_GAP + (!showVi ? LIST_EDGE : 0) }} />}
      {showVi && <col style={{ width: MICRO_COUNT_WIDTH + LIST_COLUMN_GAP + LIST_EDGE }} />}
    </colgroup>
    <thead className={`sticky top-0 z-10 bg-bg ${LIST_HEAD}`}><tr title={RESULT_KEYS_HINT}>
      {columns.map(({ key, label }, index) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.descending ? "descending" : "ascending" : "none"} className={`h-7 font-normal ${index === 0 ? "pl-3" : index === lastIndex ? `${CELL_AFTER_FIRST} pr-3` : CELL_AFTER_FIRST}`}>
        <button type="button" data-chart-control aria-label={`${label} 순으로 정렬`} onClick={() => onSort(nextSort(sort, key))}
          className={`-mx-1 flex h-[var(--ctl-xs)] w-[calc(100%+var(--size-8))] items-center gap-1 rounded-s px-1 hover:bg-[var(--hover)] hover:text-text ${index === 0 ? "" : "justify-end"} ${sort.key === key ? "text-text" : ""}`}>
          {label}{sort.key === key && <SortIcon dir={sort.descending ? "down" : "up"} />}
        </button>
      </th>)}
    </tr></thead>
    <tbody>{rows.map((row) => {
      const active = row.symbol === selected;
      return <tr key={row.symbol} data-code={row.symbol} aria-selected={active} onClick={() => onSelect(row.symbol)}
        onContextMenu={desktop ? (e) => { e.preventDefault(); openMenu(row.symbol, e.clientX, e.clientY); } : undefined}
        className={`${LIST_ROW_HEIGHT} cursor-pointer max-md:h-12 ${listRowFill(active)}`}>
        <td className="pl-3">
          <button type="button" data-chart-control data-result-row aria-current={active || undefined} className="block w-full min-w-0 text-left"
            aria-haspopup={desktop ? "menu" : undefined} aria-expanded={desktop ? menu?.code === row.symbol : undefined}
            aria-keyshortcuts={desktop ? "Shift+Enter Shift+F10" : undefined}
            onKeyDown={desktop ? (e) => {
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                openMenu(row.symbol, box.x, box.bottom);
              } else if (e.shiftKey && e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                addRowToCompare(cellId, cell, row.symbol, row.name);
              }
            } : undefined}>
            <SymbolName name={row.name} code={row.symbol} />
          </button>
        </td>
        <td className={CELL_AFTER_FIRST} title={`최신 일봉 ${row.latestBarDate}${row.provisional ? " · 당일 요약 잠정" : ""}`}>
          <PriceText>
            <span className="inline-flex flex-row-reverse items-center gap-0.5">
              {formatPrice(row.close, false)}
              {row.provisional && <span aria-label="잠정" className="text-warning">*</span>}
              {row.latestBarDate !== asOf && <span role="img" aria-label={`최신 일봉 ${row.latestBarDate.slice(5)}`} className="mr-0.5 inline-flex text-text-3"><ClockIcon /></span>}
            </span>
          </PriceText>
        </td>
        <td className={`${CELL_AFTER_FIRST} ${lastIndex === 2 ? "pr-3" : ""}`}>
          {row.changeRate === null ? <span className="block text-right text-text-3">—</span> : <RateBadge direction={direction(row.changeRate)}>{formatPercent(row.changeRate)}</RateBadge>}
        </td>
        {showProgram && <td className={`${CELL_AFTER_FIRST} ${!showWhale && !showVi ? "pr-3" : ""} text-right text-s`}>
          {row.programNetMillionWon === undefined ? <span className="text-text-3">—</span> : <span className={amountTone(row.programNetMillionWon)}>{formatSignedMillion(row.programNetMillionWon)}</span>}
        </td>}
        {showWhale && <td className={`${CELL_AFTER_FIRST} ${!showVi ? "pr-3" : ""} text-right text-s`}>
          {row.whaleNetMillionWon === undefined ? <span className="text-text-3">—</span> : <span className={amountTone(row.whaleNetMillionWon)}>{formatSignedMillion(row.whaleNetMillionWon)}</span>}
        </td>}
        {showVi && <td className={`${CELL_AFTER_FIRST} pr-3 text-right text-s text-text-2`}>
          {row.viCount === undefined ? <span className="text-text-3">—</span> : `${row.viCount.toLocaleString("ko-KR")}회`}
        </td>}
      </tr>;
    })}</tbody>
  </table>
  {menu && menuRow && <ResultRowMenu row={menuRow} menu={menu} root={table} onOpen={() => onSelect(menu.code)}
    onWatchlists={() => { table.current?.querySelector<HTMLButtonElement>(`tr[data-code="${menu.code}"] button`)?.focus(); setMenu({ ...menu, kind: "watchlists" }); }}
    onClose={() => setMenu((current) => current === menu ? null : current)} />}
  </>;
}
