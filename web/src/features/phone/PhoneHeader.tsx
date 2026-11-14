import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { CellStatus } from "../../chart/ChartController";
import { direction, formatChange, formatPercent, formatPrice } from "../../lib/format";
import { isIndexCode, symbolSub } from "../../lib/symbol";
import type { ChartWindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { CameraIcon } from "../icons";
import { saveSnapshot } from "../snapshot/saveSnapshot";
import { VenuePicker } from "../venue/VenuePicker";
import { Attribution } from "../status/attribution";
import { ConnectionIndicator, useConnectionView } from "../status/ConnectionIndicator";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;

/**
 * 휴대폰 머리(frontend.md §4): 종목과 거래소(주식만), 현재 봉 종가(24px, 등락색), 등락, 그리고 셋째 줄에
 * 연결 상태(§2.2의 점과 문장)와 라이브러리 표기. 범례의 머리줄과 가격줄을 대신한다.
 */
export function PhoneHeader({ cell, info, status }: { cell: ChartWindowState; info: SymbolInfo | undefined; status: CellStatus }) {
  const openSearch = useSelectionStore((s) => s.openSearch);
  const isIndex = isIndexCode(cell.symbol);
  const connection = useConnectionView();
  const ready = status.kind === "ready" ? status : null;
  const chg = ready?.prev ? ready.latest.c - ready.prev.c : 0;
  const dir = DIR_CLASS[direction(chg)];

  return (
    <header className="hidden px-3 pb-1 pt-2 [grid-area:mhead] max-md:block">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button type="button" className="min-w-0 flex-1 truncate text-left" aria-haspopup="dialog" onClick={() => openSearch()}>
            <b className="text-l font-[650]">{info?.name ?? cell.symbol}</b>
            <small className="ml-1 text-s text-text-3">{symbolSub(cell.symbol, info)}</small>
          </button>
          <FinancialUpdateButton />
          <button type="button" className="icon-btn h-9 w-9 flex-none" title="차트 이미지 내려받기" aria-label="차트 이미지 내려받기" onClick={() => saveSnapshot(cell.id, "download")}><CameraIcon size={20} /></button>
        </div>
        <div className="flex h-[32px] items-center gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
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
          <VenuePicker cell={cell} info={info} variant="phone" />
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-text-2">
          <ConnectionIndicator view={connection} />
          <Attribution text="Lightweight Charts™" className="text-text-3 underline underline-offset-2" />
        </div>
      </div>
    </header>
  );
}
