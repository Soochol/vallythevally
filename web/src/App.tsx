import { useRefetchNamesOnConnect } from "./api/refetchNamesOnConnect";
import { FinancialUpdateDialog } from "./features/financial-update/FinancialUpdateDialog";
import { ConfirmHost } from "./features/overlay/Confirm";
import { TooltipHost } from "./features/overlay/Tooltip";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { PageRail } from "./features/page-rail/PageRail";
import { PageStage } from "./features/page-rail/PageStage";
import { PageTopbar } from "./features/page-rail/PageTopbar";
import { useHiddenWorkspaceKeys } from "./features/page-rail/useHiddenWorkspaceKeys";
import { isContentPage, pageOfPath, type PageId } from "./features/page-rail/pages";
import { loadKiwoomLink } from "./api/system";
import { SystemSettingsDialog } from "./features/system-settings/SystemSettingsDialog";
import { useSymbolInfo } from "./api/queries";
import type { CellStatus } from "./chart/ChartController";
import { ChartCell } from "./features/grid/ChartCell";
import { PeriodChips } from "./features/phone/PeriodChips";
import { PhoneHeader } from "./features/phone/PhoneHeader";
import { PhoneTabs } from "./features/phone/PhoneTabs";
import { IndicatorCommand } from "./features/indicator-command/IndicatorCommand";
import { ScreenDialog } from "./features/screen-dialog/ScreenDialog";
import { PhoneScreener } from "./features/screener/ScreenerPanel";
import { Landing } from "./features/landing/Landing";
import { PublicSetupWizard } from "./public-mode/PublicSetupWizard";
import { PublicUnavailable } from "./public-mode/PublicUnavailable";
import { usePublicMode } from "./public-mode/serverMode";
import { SetupWizard } from "./features/setup-wizard/SetupWizard";
import { needsChoice, useWizardOpening, useWizardStore, wizardVisible } from "./features/setup-wizard/wizardOpen";
import { SetupChangedNotice } from "./features/status/SetupChangedNotice";
import { ReplaceLocalScreen } from "./features/account/ReplaceLocalScreen";
import { useAccountStore } from "./stores/account";
import { SearchDialog } from "./features/search/SearchDialog";
import { StatusBar } from "./features/status/StatusBar";
import { Toast } from "./features/toast/Toast";
import { Topbar } from "./features/topbar/Topbar";
import { useHotkeys } from "./features/useHotkeys";
import { useArrangementKeys } from "./features/workspace/useArrangementKeys";
import { useOpenFromAddress } from "./features/useOpenFromAddress";
import { useCell } from "./stores/layout";
import { PhoneSaveBand } from "./features/status/SaveStatus";
import { PhoneWatch } from "./features/watch/Watchlist";
import { usePersistStore } from "./stores/persist";
import { useSelectionStore } from "./stores/selection";
import { useUiStore } from "./stores/ui";
import { DrawingToolbar } from "./features/drawings/DrawingToolbar";
import { Workspace } from "./features/workspace/Workspace";
import { DESKTOP_QUERY, useMediaQuery } from "./lib/media";
import type { WindowId } from "./layout/kinds";

export function ChartRoute() {
  const page = pageOfPath(useLocation().pathname) ?? "workspace";
  const restoring = usePersistStore((s) => s.phase.kind === "restoring");
  const account = useAccountStore((s) => s.status);
  const wizardOpen = useWizardStore((s) => s.open);
  const publicMode = usePublicMode();
  useWizardOpening(account);
  useRefetchNamesOnConnect();
  if (account?.state === "signed_out") return <Landing />;
  if (account?.state === "owner_mismatch") return <ReplaceLocalScreen status={account} />;
  return (
    <>
      {restoring || needsChoice(account) ? <div className="h-dvh bg-bg" aria-busy="true" aria-label="마지막 화면을 불러오는 중" /> : <ChartScreen page={page} />}
      {page === "home" && <div className="fixed inset-0 z-50 bg-bg"><Landing /></div>}
      {wizardVisible(account, wizardOpen) && (publicMode ? <PublicSetupWizard /> : <SetupWizard />)}
    </>
  );
}

function ChartScreen({ page }: { page: PageId }) {
  const onWorkspace = page === "workspace";
  const cellId = useSelectionStore((s) => s.activeCell);
  const cell = useCell(cellId);
  const info = useSymbolInfo(cell.symbol).data;
  const pushRecent = useUiStore((s) => s.pushRecent);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const publicMode = usePublicMode();
  const [phoneStatus, setPhoneStatus] = useState<{ cellId: WindowId; status: CellStatus } | null>(null);
  const status: CellStatus = phoneStatus?.cellId === cellId ? phoneStatus.status : { kind: "loading" };

  useHiddenWorkspaceKeys(!onWorkspace);
  useHotkeys(onWorkspace);
  useArrangementKeys(onWorkspace);
  useEffect(() => {
    const { loginFailure, showLoginFailure } = useAccountStore.getState();
    if (loginFailure === null) return;
    useSelectionStore.getState().showToast(loginFailure);
    showLoginFailure(null);
  }, []);
  useEffect(() => {
    const load = new AbortController();
    void loadKiwoomLink(load.signal);
    return () => load.abort();
  }, []);
  useOpenFromAddress(onWorkspace);
  useEffect(() => {
    if (info) pushRecent(info.code);
  }, [info, pushRecent]);

  const phoneGrid = onWorkspace
    ? "max-md:grid-rows-[auto_auto_minmax(0,1fr)_56px] max-md:[grid-template-areas:'mhead'_'mper'_'grid'_'mtabs']"
    : "max-md:grid-rows-[minmax(0,1fr)] max-md:[grid-template-areas:'grid']";
  const shownPage = isContentPage(page) ? page : null;

  return (
    <div
      inert={page === "home"}
      className={
        "app-shell relative flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-bg max-md:grid max-md:grid-cols-[minmax(0,1fr)] " +
        phoneGrid +
        (page === "home" ? " invisible" : "")
      }
    >
      {onWorkspace ? <Topbar /> : <PageTopbar />}
      {onWorkspace && <PhoneHeader cell={cell} info={info} status={status} />}
      {onWorkspace && <PeriodChips cell={cell} />}
      {desktop ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <div inert={!onWorkspace} className={"absolute inset-0 flex" + (onWorkspace ? "" : " invisible")}>
              <DrawingToolbar />
              <Workspace />
            </div>
            {shownPage && <PageStage page={shownPage} />}
          </div>
          <PageRail page={page} />
        </div>
      ) : (
        <>
          <main aria-label="칸" inert={!onWorkspace} className={"grid min-h-0 min-w-0 grid-cols-1 grid-rows-1 [grid-area:grid]" + (onWorkspace ? "" : " invisible")}>
            {publicMode ? <PublicUnavailable /> : <ChartCell key={cellId} cellId={cellId} status={status} onStatus={(next) => setPhoneStatus({ cellId, status: next })} />}
          </main>
          {shownPage && <PageStage page={shownPage} />}
        </>
      )}
      <StatusBar />
      {onWorkspace && <PhoneTabs />}
      <PhoneWatch />
      <PhoneScreener />
      <PhoneSaveBand />
      <SearchDialog />
      <IndicatorCommand />
      <ScreenDialog />
      <FinancialUpdateDialog />
      <SystemSettingsDialog />
      <SetupChangedNotice />
      <Toast />
      <ConfirmHost />
      <TooltipHost />
    </div>
  );
}
