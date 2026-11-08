import { useEffect, useState } from "react";
import { useSymbolInfo } from "./api/queries";
import type { CellStatus } from "./chart/ChartController";
import { ChartCell } from "./features/grid/ChartCell";
import { SearchDialog } from "./features/search/SearchDialog";
import { StatusBar } from "./features/status/StatusBar";
import { Toast } from "./features/toast/Toast";
import { Topbar } from "./features/topbar/Topbar";
import { useHotkeys } from "./features/useHotkeys";
import { useOpenFromAddress } from "./features/useOpenFromAddress";
import { useCell } from "./stores/layout";
import { useRecentStore } from "./stores/recent";
import { useSelectionStore } from "./stores/selection";

/** 차트 화면. 데스크톱과 휴대폰이 같은 라우트를 쓰고 폭에 따라 껍데기만 바꾼다(frontend.md §5.1). */
export function ChartScreen() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const pushRecent = useRecentStore((s) => s.push);
  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });

  useHotkeys();
  useOpenFromAddress();
  useEffect(() => {
    if (info) pushRecent(info);
  }, [info, pushRecent]);

  return (
    <div
      className={
        "grid h-dvh grid-cols-[minmax(0,1fr)] " +
        "grid-rows-[var(--topbar-h)_minmax(0,1fr)_var(--status-h)] [grid-template-areas:'top'_'grid'_'status'] " +
        "max-md:grid-rows-[auto_auto_minmax(0,1fr)_56px] max-md:[grid-template-areas:'mhead'_'mper'_'grid'_'mtabs']"
      }
    >
      <Topbar />
      <main aria-label="칸" className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 bg-line [grid-area:grid]">
        <ChartCell slot={slot} status={status} onStatus={setStatus} />
      </main>
      <StatusBar />
      <SearchDialog />
      <Toast />
    </div>
  );
}
