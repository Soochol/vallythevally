import { useEffect, useState } from "react";
import { useSymbolInfo } from "./api/queries";
import type { CellStatus } from "./chart/ChartController";
import { ChartCell } from "./features/grid/ChartCell";
import { PeriodChips } from "./features/phone/PeriodChips";
import { PhoneHeader } from "./features/phone/PhoneHeader";
import { PhoneTabs } from "./features/phone/PhoneTabs";
import { SearchDialog } from "./features/search/SearchDialog";
import { StatusBar } from "./features/status/StatusBar";
import { Toast } from "./features/toast/Toast";
import { Topbar } from "./features/topbar/Topbar";
import { useHotkeys } from "./features/useHotkeys";
import { useOpenFromAddress } from "./features/useOpenFromAddress";
import { useCell } from "./stores/layout";
import { PhoneSaveBand } from "./features/status/SaveStatus";
import { PhoneWatch, WatchPanel } from "./features/watch/Watchlist";
import { usePersistStore } from "./stores/persist";
import { useSelectionStore } from "./stores/selection";
import { useUiStore } from "./stores/ui";

/**
 * 차트 화면. 서버에서 마지막 화면을 되살리기 전에는 그리지 않는다. 기본 칸(코스피)으로 먼저 봉을 받았다가
 * 곧바로 바꾸는 낭비와 깜박임을 막는다. 주소의 `?symbol=`도 되살린 뒤에 적용된다.
 */
export function ChartRoute() {
  const restoring = usePersistStore((s) => s.phase.kind === "restoring");
  return restoring ? <div className="h-dvh bg-bg" aria-busy="true" aria-label="마지막 화면을 불러오는 중" /> : <ChartScreen />;
}

/** 데스크톱과 휴대폰이 같은 라우트를 쓰고 폭에 따라 껍데기만 바꾼다(frontend.md §5.1). */
function ChartScreen() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const pushRecent = useUiStore((s) => s.pushRecent);
  const watchCollapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });

  useHotkeys();
  useOpenFromAddress();
  useEffect(() => {
    if (info) pushRecent(info.code);
  }, [info, pushRecent]);

  return (
    <div
      className={
        "grid h-dvh " +
        (watchCollapsed ? "grid-cols-[minmax(0,1fr)_28px] " : "grid-cols-[minmax(0,1fr)_var(--watch-w)] ") +
        "grid-rows-[var(--topbar-h)_minmax(0,1fr)_var(--status-h)] [grid-template-areas:'top_top'_'grid_watch'_'status_status'] " +
        "max-md:grid-cols-[minmax(0,1fr)] max-md:grid-rows-[auto_auto_minmax(0,1fr)_56px] max-md:[grid-template-areas:'mhead'_'mper'_'grid'_'mtabs']"
      }
    >
      <Topbar />
      <PhoneHeader cell={cell} info={info} status={status} />
      <PeriodChips cell={cell} />
      <main aria-label="칸" className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 bg-line [grid-area:grid]">
        <ChartCell slot={slot} status={status} onStatus={setStatus} />
      </main>
      <WatchPanel />
      <StatusBar />
      <PhoneTabs />
      <PhoneWatch />
      <PhoneSaveBand />
      <SearchDialog />
      <Toast />
    </div>
  );
}
