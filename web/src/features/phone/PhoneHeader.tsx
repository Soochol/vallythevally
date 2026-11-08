import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { CellStatus } from "../../chart/ChartController";
import { formatKstClock } from "../../chart/time";
import { direction, formatChange, formatPercent, formatPrice } from "../../lib/format";
import { isIndexCode, symbolSub } from "../../lib/symbol";
import type { CellState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useThemeStore } from "../../stores/theme";
import { MoonIcon, SunIcon } from "../icons";
import { VenuePicker } from "../venue/VenuePicker";
import { Attribution } from "../status/attribution";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;

/**
 * 휴대폰 머리(frontend.md §4): 종목과 거래소(주식만), 현재 봉 종가(24px, 등락색), 등락, 그리고 셋째 줄에
 * 마지막 조회 시각과 라이브러리 표기. 범례의 머리줄과 가격줄을 대신한다.
 */
export function PhoneHeader({ cell, info, status }: { cell: CellState; info: SymbolInfo | undefined; status: CellStatus }) {
  const openDialog = useSelectionStore((s) => s.openDialog);
  const { theme, toggle } = useThemeStore();
  const isIndex = isIndexCode(cell.symbol);
  const ready = status.kind === "ready" ? status : null;
  const chg = ready?.prev ? ready.latest.c - ready.prev.c : 0;
  const dir = DIR_CLASS[direction(chg)];

  return (
    <header className="hidden items-center gap-2 px-3 pb-1 pt-2 [grid-area:mhead] max-md:flex">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button type="button" className="min-w-0 flex-1 truncate text-left" aria-haspopup="dialog" onClick={() => openDialog("search")}>
            <b className="text-l font-[650]">{info?.name ?? cell.symbol}</b>
            <small className="ml-1 text-s text-text-3">{symbolSub(cell.symbol, info)}</small>
          </button>
          <VenuePicker cell={cell} info={info} variant="phone" />
        </div>
        <div className="flex h-[32px] items-baseline gap-2">
          {ready ? (
            <>
              <strong className={`text-[24px] font-[650] tracking-[-0.02em] ${dir}`}>{formatPrice(ready.latest.c, isIndex)}</strong>
              {ready.prev && (
                <span className={`whitespace-pre ${dir}`}>
                  {formatChange(chg, isIndex)} {formatPercent((chg / ready.prev.c) * 100)}
                </span>
              )}
            </>
          ) : (
            <strong className="text-[24px] font-[650] text-text-3">—</strong>
          )}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-text-2">
          <span>{ready ? `조회 값 ${formatKstClock(ready.fetchedAt / 1000)}` : status.kind === "loading" ? "조회 중" : ""}</span>
          <Attribution text="Lightweight Charts™" className="text-text-3 underline underline-offset-2" />
        </div>
      </div>
      <button type="button" className="icon-btn h-9 w-9" title="테마 바꾸기" aria-label="테마 바꾸기" onClick={toggle}>
        {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
      </button>
    </header>
  );
}
