import { useEffect, useMemo, useRef, useState } from "react";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { direction, formatMillionWonCompact, formatPercent, formatPrice, MINUS } from "../../lib/format";
import {
  matchedDateText,
  nextSort,
  SCREENER_COLUMN_LABEL,
  type ResultSort,
  type ResultSortKey,
  type ScreenerExtraColumn,
} from "../../lib/screener";
import { WATCH_COLUMN_LABEL } from "../../lib/watchlist";
import { useCell } from "../../stores/layout";
import { useScreenerStore } from "../../stores/screener";
import { useSelectionStore } from "../../stores/selection";
import { addRowToCompare } from "../list/symbolRowMenu";
import { ClockIcon, SortIcon } from "../icons";
import { ResultRowMenu, type ResultMenuState } from "./ResultRowMenu";
import { activeScreenerColumns } from "./ScreenerColumnPicker";
import {
  LIST_COLUMN_GAP,
  LIST_EDGE,
  LIST_HEAD,
  LIST_PRICE_WIDTH,
  LIST_RATE_WIDTH,
  LIST_ROW_HEIGHT,
  PriceText,
  RateBadge,
  SymbolName,
  listRowFill,
} from "../list/listRow";

const BASE_COLUMNS: readonly { key: ResultSortKey; label: string }[] = [
  { key: "name", label: "종목" },
  { key: "close", label: WATCH_COLUMN_LABEL.price },
  { key: "changeRate", label: "등락률" },
];
const EXTRA_COLUMN_WIDTH: Record<ScreenerExtraColumn, number> = {
  tradedMillionWon: 64,
  programNetMillionWon: 74,
  whaleNetMillionWon: 74,
  viCount: 44,
  matchedDate: 54,
};
const CELL_AFTER_FIRST = "pl-1";
export const RESULT_KEYS_HINT = "↑↓ 결과 이동 · ↵ 칸에 열기";

function formatSignedMillion(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${prefix}${Math.abs(value).toLocaleString("ko-KR")}백만`;
}

function amountTone(value: number): string {
  const dir = direction(value);
  return dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-text-2";
}

function barFillClass(kind: "accent" | "signed", value: number): string {
  if (kind === "accent") return "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]";
  const dir = direction(value);
  if (dir === "up") return "bg-[color-mix(in_srgb,var(--up)_16%,transparent)]";
  if (dir === "down") return "bg-[color-mix(in_srgb,var(--down)_16%,transparent)]";
  return "";
}

function barWidthPct(value: number, maxAbs: number): number {
  if (maxAbs <= 0) return 0;
  return Math.max(4, Math.min(100, Math.round((Math.abs(value) / maxAbs) * 100)));
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
  const extraColumns = useScreenerStore((s) => s.extraColumns);
  const hiddenAutoColumns = useScreenerStore((s) => s.hiddenAutoColumns);
  const showBars = useScreenerStore((s) => s.showBars);

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

  const activeExtra = useMemo(
    () => activeScreenerColumns(rows, extraColumns, hiddenAutoColumns),
    [rows, extraColumns, hiddenAutoColumns],
  );
  const columns: { key: ResultSortKey; label: string }[] = useMemo(
    () => [
      ...BASE_COLUMNS,
      ...activeExtra.map((key) => ({ key, label: SCREENER_COLUMN_LABEL[key] })),
    ],
    [activeExtra],
  );
  const maxes = useMemo(() => {
    let traded = 0;
    let program = 0;
    let whale = 0;
    for (const row of rows) {
      if (row.tradedMillionWon !== undefined && row.tradedMillionWon > traded) traded = row.tradedMillionWon;
      if (row.programNetMillionWon !== undefined && Math.abs(row.programNetMillionWon) > program) program = Math.abs(row.programNetMillionWon);
      if (row.whaleNetMillionWon !== undefined && Math.abs(row.whaleNetMillionWon) > whale) whale = Math.abs(row.whaleNetMillionWon);
    }
    return { traded, program, whale };
  }, [rows]);

  const lastIndex = columns.length - 1;
  return <>
  <table ref={table} aria-label={`${screen.name} 결과`} className="w-full table-fixed border-collapse text-b tabular-nums">
    <colgroup>
      <col />
      <col style={{ width: LIST_PRICE_WIDTH + LIST_COLUMN_GAP }} />
      <col style={{ width: LIST_RATE_WIDTH + LIST_COLUMN_GAP + (lastIndex === 2 ? LIST_EDGE : 0) }} />
      {activeExtra.map((col, extraIdx) => (
        <col
          key={col}
          style={{ width: EXTRA_COLUMN_WIDTH[col] + LIST_COLUMN_GAP + (extraIdx === activeExtra.length - 1 ? LIST_EDGE : 0) }}
        />
      ))}
    </colgroup>
    <thead className={`sticky top-0 z-10 border-b border-line bg-[color-mix(in_srgb,var(--raised)_45%,var(--surface))] ${LIST_HEAD}`}><tr title={RESULT_KEYS_HINT}>
      {columns.map(({ key, label }, index) => (
        <th key={key} scope="col" aria-sort={sort.key === key ? sort.descending ? "descending" : "ascending" : "none"} className={`h-7 font-normal ${index === 0 ? "pl-3" : index === lastIndex ? `${CELL_AFTER_FIRST} pr-3` : CELL_AFTER_FIRST}`}>
          <button
            type="button"
            data-chart-control
            aria-label={`${label} 순으로 정렬`}
            onClick={() => onSort(nextSort(sort, key))}
            className={`-mx-1 flex h-[var(--ctl-xs)] w-[calc(100%+var(--size-8))] items-center gap-1 rounded-s px-1 hover:bg-[var(--hover)] hover:text-text ${index === 0 ? "" : "justify-end"} ${sort.key === key ? "font-[600] text-accent" : ""}`}
          >
            {label}{sort.key === key && <SortIcon dir={sort.descending ? "down" : "up"} />}
          </button>
        </th>
      ))}
    </tr></thead>
    <tbody>{rows.map((row, rowIndex) => {
      const active = row.symbol === selected;
      const rowShadow = active
        ? rowIndex > 0
          ? "shadow-[inset_2px_0_0_var(--accent),inset_0_1px_0_var(--line-subtle)]"
          : "shadow-[inset_2px_0_0_var(--accent)]"
        : rowIndex > 0
          ? "shadow-[inset_0_1px_0_var(--line-subtle)]"
          : "";
      return <tr key={row.symbol} data-code={row.symbol} aria-selected={active} onClick={() => onSelect(row.symbol)}
        onContextMenu={desktop ? (e) => { e.preventDefault(); openMenu(row.symbol, e.clientX, e.clientY); } : undefined}
        className={`${LIST_ROW_HEIGHT} cursor-pointer max-md:h-12 ${listRowFill(active)} ${rowShadow}`}>
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
          {row.changeRate === null ? <span className="block text-right text-xs text-text-3">—</span> : <RateBadge direction={direction(row.changeRate)}>{formatPercent(row.changeRate)}</RateBadge>}
        </td>
        {activeExtra.map((col, extraIdx) => {
          const pad = `${CELL_AFTER_FIRST} ${extraIdx === activeExtra.length - 1 ? "pr-3" : ""}`;
          if (col === "tradedMillionWon") {
            const val = row.tradedMillionWon;
            return (
              <td key={col} className={`${pad} text-right text-xs`}>
                {val === undefined ? (
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="relative inline-flex h-[22px] w-full items-center justify-end overflow-hidden rounded-s px-1">
                    {showBars && maxes.traded > 0 && (
                      <span aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 rounded-s ${barFillClass("accent", val)}`} style={{ width: `${barWidthPct(val, maxes.traded)}%` }} />
                    )}
                    <span className="relative text-text-2">{formatMillionWonCompact(val)}</span>
                  </span>
                )}
              </td>
            );
          }
          if (col === "programNetMillionWon") {
            const val = row.programNetMillionWon;
            return (
              <td key={col} className={`${pad} text-right text-xs`}>
                {val === undefined ? (
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="relative inline-flex h-[22px] w-full items-center justify-end overflow-hidden rounded-s px-1">
                    {showBars && maxes.program > 0 && val !== 0 && (
                      <span aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 rounded-s ${barFillClass("signed", val)}`} style={{ width: `${barWidthPct(val, maxes.program)}%` }} />
                    )}
                    <span className={`relative font-[500] ${amountTone(val)}`}>{formatSignedMillion(val)}</span>
                  </span>
                )}
              </td>
            );
          }
          if (col === "whaleNetMillionWon") {
            const val = row.whaleNetMillionWon;
            return (
              <td key={col} className={`${pad} text-right text-xs`}>
                {val === undefined ? (
                  <span className="text-text-3">—</span>
                ) : (
                  <span className="relative inline-flex h-[22px] w-full items-center justify-end overflow-hidden rounded-s px-1">
                    {showBars && maxes.whale > 0 && val !== 0 && (
                      <span aria-hidden="true" className={`pointer-events-none absolute inset-y-0 right-0 rounded-s ${barFillClass("signed", val)}`} style={{ width: `${barWidthPct(val, maxes.whale)}%` }} />
                    )}
                    <span className={`relative font-[500] ${amountTone(val)}`}>{formatSignedMillion(val)}</span>
                  </span>
                )}
              </td>
            );
          }
          if (col === "viCount") {
            return (
              <td key={col} className={`${pad} text-right text-xs text-text-2`}>
                {row.viCount === undefined ? <span className="text-text-3">—</span> : `${row.viCount.toLocaleString("ko-KR")}회`}
              </td>
            );
          }
          const matched = matchedDateText(screen, row.matchedDate, asOf);
          return (
            <td key={col} className={`${pad} text-right text-xs ${matched.current ? "font-[600] text-accent" : "text-text-3"}`}>
              {matched.text}
            </td>
          );
        })}
      </tr>;
    })}</tbody>
  </table>
  {menu && menuRow && <ResultRowMenu row={menuRow} menu={menu} root={table} onOpen={() => onSelect(menu.code)}
    onWatchlists={() => { table.current?.querySelector<HTMLButtonElement>(`tr[data-code="${menu.code}"] button`)?.focus(); setMenu({ ...menu, kind: "watchlists" }); }}
    onClose={() => setMenu((current) => current === menu ? null : current)} />}
  </>;
}
