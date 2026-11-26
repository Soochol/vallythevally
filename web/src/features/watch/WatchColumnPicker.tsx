import { useRef, useState } from "react";
import {
  DEFAULT_WATCH_COLUMNS,
  isMicroWatchColumn,
  WATCH_COLUMN_LABEL,
  WATCH_COLUMN_PRESETS,
  WATCH_COLUMNS,
  type WatchColumn,
} from "../../lib/watchlist";
import { useUiStore } from "../../stores/ui";
import { useWatchMicroState } from "../../stores/watchMicro";
import { ArrowIcon, CheckIcon, SlidersIcon } from "../icons";
import { Popover } from "../overlay/Popover";

const sameColumns = (a: readonly WatchColumn[], b: readonly WatchColumn[]) =>
  a.length === b.length && a.every((col, index) => col === b[index]);

export function WatchColumnPicker({ hidden }: { hidden: readonly WatchColumn[] }) {
  const columns = useUiStore((s) => s.prefs.watchColumns);
  const microState = useWatchMicroState();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const ui = useUiStore.getState();
  const ordered: WatchColumn[] = [
    ...columns,
    ...WATCH_COLUMNS.filter((column) => !columns.includes(column)),
  ];
  const isDefault = sameColumns(columns, DEFAULT_WATCH_COLUMNS);
  const hasMicro = columns.some(isMicroWatchColumn);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`inline-flex h-7 flex-none items-center gap-1 rounded-m px-1.5 text-xs font-[500] max-md:h-9 max-md:px-2 ${
          open || !isDefault
            ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]"
            : "text-text-2 hover:bg-[var(--hover)] hover:text-text"
        }`}
        title="관심종목 표시 열 설정"
        aria-label="관심종목 열 설정"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <SlidersIcon size={13} />
        <span>열</span>
      </button>
      {open && (
        <Popover
          anchor={trigger}
          placement="bottom"
          role="dialog"
          aria-label="관심종목 열 설정"
          solid
          onClose={() => setOpen(false)}
          className="w-[248px] p-2.5"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-[600] text-text">표시 열 설정</span>
            {!isDefault && (
              <button
                type="button"
                className="rounded-s px-1.5 py-0.5 text-xs text-text-2 hover:bg-[var(--hover)] hover:text-text"
                onClick={() => ui.setWatchColumns(DEFAULT_WATCH_COLUMNS)}
              >
                기본으로
              </button>
            )}
          </div>
          <div role="group" aria-label="열 프리셋" className="mb-2.5 flex flex-wrap gap-1">
            {WATCH_COLUMN_PRESETS.map((preset) => {
              const active = sameColumns(columns, preset.columns);
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => ui.setWatchColumns(preset.columns)}
                  className={`h-6 rounded-s px-2 text-xs font-[500] transition-colors ${
                    active
                      ? "bg-accent-soft text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)]"
                      : "bg-raised text-text-2 hover:bg-overlay hover:text-text"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <ul className="space-y-0.5 border-t border-line pt-2" aria-label="표시할 열 목록">
            {ordered.map((column) => {
              const activeIndex = columns.indexOf(column);
              const checked = activeIndex >= 0;
              const isHidden = hidden.includes(column);
              return (
                <li
                  key={column}
                  className="flex h-7 items-center gap-1.5 rounded-s px-1.5 hover:bg-[var(--hover)]"
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                    onClick={() => ui.toggleWatchColumn(column)}
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
                      {WATCH_COLUMN_LABEL[column]}
                    </span>
                    {isHidden && (
                      <span className="rounded-s bg-warning-soft px-1 text-xs text-warning">
                        숨김
                      </span>
                    )}
                  </button>
                  {checked && (
                    <span className="flex flex-none items-center gap-0.5">
                      <button
                        type="button"
                        className="icon-btn h-5 w-5"
                        aria-label={`${WATCH_COLUMN_LABEL[column]} 위로`}
                        disabled={activeIndex === 0}
                        onClick={() => ui.moveWatchColumn(column, -1)}
                      >
                        <ArrowIcon dir="up" size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn h-5 w-5"
                        aria-label={`${WATCH_COLUMN_LABEL[column]} 아래로`}
                        disabled={activeIndex === columns.length - 1}
                        onClick={() => ui.moveWatchColumn(column, 1)}
                      >
                        <ArrowIcon dir="down" size={12} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {hasMicro && microState === "disabled" && (
            <p className="mt-2 border-t border-line pt-1.5 text-xs text-text-3">
              수집기가 연결되지 않으면 프로그램·고래 열은 —로 표시됩니다.
            </p>
          )}
        </Popover>
      )}
    </>
  );
}
