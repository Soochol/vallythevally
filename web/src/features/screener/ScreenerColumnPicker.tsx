import { useRef, useState } from "react";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import {
  SCREENER_COLUMN_LABEL,
  SCREENER_EXTRA_COLUMNS,
  type ScreenerExtraColumn,
} from "../../lib/screener";
import { useScreenerStore } from "../../stores/screener";
import { CheckIcon, SlidersIcon } from "../icons";
import { Popover } from "../overlay/Popover";

export function autoScreenerColumns(rows: readonly ScreenerRow[]): ReadonlySet<ScreenerExtraColumn> {
  const auto = new Set<ScreenerExtraColumn>();
  if (rows.some((row) => row.programNetMillionWon !== undefined)) auto.add("programNetMillionWon");
  if (rows.some((row) => row.whaleNetMillionWon !== undefined)) auto.add("whaleNetMillionWon");
  if (rows.some((row) => row.viCount !== undefined)) auto.add("viCount");
  return auto;
}

export function activeScreenerColumns(
  rows: readonly ScreenerRow[],
  extraColumns: readonly ScreenerExtraColumn[],
  hiddenAutoColumns: readonly ScreenerExtraColumn[],
): ScreenerExtraColumn[] {
  const auto = autoScreenerColumns(rows);
  return SCREENER_EXTRA_COLUMNS.filter((column) =>
    auto.has(column) ? !hiddenAutoColumns.includes(column) : extraColumns.includes(column),
  );
}

export function ScreenerColumnPicker({ rows }: { rows: readonly ScreenerRow[] }) {
  const extraColumns = useScreenerStore((s) => s.extraColumns);
  const hiddenAutoColumns = useScreenerStore((s) => s.hiddenAutoColumns);
  const showBars = useScreenerStore((s) => s.showBars);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const auto = autoScreenerColumns(rows);
  const active = activeScreenerColumns(rows, extraColumns, hiddenAutoColumns);
  const customized = extraColumns.length > 0 || hiddenAutoColumns.length > 0 || !showBars;
  const store = useScreenerStore.getState();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-chart-control
        className={`inline-flex h-[var(--ctl-xs)] flex-none items-center gap-1 rounded-s px-1.5 text-xs font-[500] ${
          open || customized
            ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
            : "text-text-2 hover:bg-[var(--hover)] hover:text-text"
        }`}
        title="스크리너 표시 열 설정"
        aria-label="스크리너 열 설정"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <SlidersIcon size={12} />
        <span>열</span>
      </button>
      {open && (
        <Popover
          anchor={trigger}
          placement="bottom"
          role="dialog"
          aria-label="스크리너 열 설정"
          solid
          onClose={() => setOpen(false)}
          className="w-[216px] p-2.5"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-[600] text-text">결과 열 설정</span>
            {customized && (
              <button
                type="button"
                className="rounded-s px-1.5 py-0.5 text-xs text-text-2 hover:bg-[var(--hover)] hover:text-text"
                onClick={() => store.resetColumns()}
              >
                기본으로
              </button>
            )}
          </div>
          <ul className="space-y-0.5" aria-label="스크리너 추가 열">
            {SCREENER_EXTRA_COLUMNS.map((column) => {
              const isAuto = auto.has(column);
              const checked = active.includes(column);
              return (
                <li key={column}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="flex h-7 w-full items-center gap-2 rounded-s px-1.5 text-left text-xs hover:bg-[var(--hover)]"
                    onClick={() => store.toggleColumn(column, isAuto)}
                  >
                    <span
                      className={`grid size-4 flex-none place-items-center rounded-s border ${
                        checked
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-[var(--line-strong)] bg-transparent text-transparent"
                      }`}
                    >
                      <CheckIcon size={11} />
                    </span>
                    <span className={checked ? "font-[500] text-text" : "text-text-2"}>
                      {SCREENER_COLUMN_LABEL[column]}
                    </span>
                    {isAuto && (
                      <span className="ml-auto text-xs text-text-3">조건</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 border-t border-line pt-2">
            <button
              type="button"
              role="checkbox"
              aria-checked={showBars}
              className="flex h-7 w-full items-center gap-2 rounded-s px-1.5 text-left text-xs hover:bg-[var(--hover)]"
              onClick={() => store.setShowBars(!showBars)}
            >
              <span
                className={`grid size-4 flex-none place-items-center rounded-s border ${
                  showBars
                    ? "border-accent bg-accent text-accent-ink"
                    : "border-[var(--line-strong)] bg-transparent text-transparent"
                }`}
              >
                <CheckIcon size={11} />
              </span>
              <span className={showBars ? "font-[500] text-text" : "text-text-2"}>
                비중 강조 바 표시
              </span>
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
