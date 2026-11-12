import { ConfirmHost } from "./features/overlay/Confirm";
import { TooltipHost } from "./features/overlay/Tooltip";
import { useEffect, useState } from "react";
import { useSymbolInfo } from "./api/queries";
import type { CellStatus } from "./chart/ChartController";
import { ChartCell } from "./features/grid/ChartCell";
import { PeriodChips } from "./features/phone/PeriodChips";
import { PhoneHeader } from "./features/phone/PhoneHeader";
import { PhoneTabs } from "./features/phone/PhoneTabs";
import { IndicatorCommand } from "./features/indicator-command/IndicatorCommand";
import { ScreenDialog } from "./features/screen-dialog/ScreenDialog";
import { PhoneScreener } from "./features/screener/ScreenerPanel";
import { SearchDialog } from "./features/search/SearchDialog";
import { StatusBar } from "./features/status/StatusBar";
import { Toast } from "./features/toast/Toast";
import { Topbar } from "./features/topbar/Topbar";
import { useHotkeys } from "./features/useHotkeys";
import { useOpenFromAddress } from "./features/useOpenFromAddress";
import { useCell } from "./stores/layout";
import { PhoneSaveBand } from "./features/status/SaveStatus";
import { RightPanel, useRightPanelWidth } from "./features/panel/RightPanel";
import { PhoneWatch } from "./features/watch/Watchlist";
import { usePersistStore } from "./stores/persist";
import { useSelectionStore } from "./stores/selection";
import { useUiStore } from "./stores/ui";
import { DrawingToolbar } from "./features/drawings/DrawingToolbar";

export function ChartRoute() {
  const restoring = usePersistStore((s) => s.phase.kind === "restoring");
  return restoring ? <div className="h-dvh bg-bg" aria-busy="true" aria-label="마지막 화면을 불러오는 중" /> : <ChartScreen />;
}

function ChartScreen() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const cell = useCell(slot);
  const info = useSymbolInfo(cell.symbol).data;
  const pushRecent = useUiStore((s) => s.pushRecent);
  const panelWidth = useRightPanelWidth();
  const [status, setStatus] = useState<CellStatus>({ kind: "loading" });

  useHotkeys();
  useOpenFromAddress();
  useEffect(() => {
    if (info) pushRecent(info.code);
  }, [info, pushRecent]);

  return (
    <div
      style={{ "--watch-w": `min(${panelWidth}px, 55vw)` } as React.CSSProperties}
      className={
        "relative grid h-dvh min-h-0 min-w-0 overflow-hidden grid-cols-[minmax(0,1fr)_var(--watch-w)] " +
        "grid-rows-[var(--topbar-h)_minmax(0,1fr)_var(--status-h)] [grid-template-areas:'top_top'_'grid_watch'_'status_status'] " +
        "max-md:grid-cols-[minmax(0,1fr)] max-md:grid-rows-[auto_auto_minmax(0,1fr)_56px] max-md:[grid-template-areas:'mhead'_'mper'_'grid'_'mtabs']"
      }
    >
      <Topbar />
      <PhoneHeader cell={cell} info={info} status={status} />
      <PeriodChips cell={cell} />
      <main aria-label="칸" className="grid min-h-0 min-w-0 grid-cols-[var(--tools-w)_minmax(0,1fr)] grid-rows-1 bg-line [grid-area:grid] max-md:grid-cols-1">
        <DrawingToolbar />
        <ChartCell slot={slot} status={status} onStatus={setStatus} />
      </main>
      <RightPanel />
      <StatusBar />
      <PhoneTabs />
      <PhoneWatch />
      <PhoneScreener />
      <PhoneSaveBand />
      <SearchDialog />
      <IndicatorCommand />
      <ScreenDialog />
      <Toast />
      <ConfirmHost />
      <TooltipHost />
    </div>
  );
}
