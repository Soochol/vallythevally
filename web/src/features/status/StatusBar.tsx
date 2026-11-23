import { usePublicMode } from "../../public-mode/serverMode";
import { useKiwoomStore } from "../../stores/kiwoom";
import { Attribution } from "./attribution";
import { ConnectionIndicator, useConnectionView } from "./ConnectionIndicator";
import { FinancialStatus } from "./FinancialStatus";
import { MarketClock } from "./MarketClock";
import { SaveStatus } from "./SaveStatus";
import { SyncIndicator } from "./SyncIndicator";

const STOPPED_TEXT = "키움 조회 멈춤";

export function StatusBar() {
  const stopped = useKiwoomStore((s) => s.stopped);
  const notice = useKiwoomStore((s) => s.notice);
  const connection = useConnectionView();
  const publicMode = usePublicMode();
  return (
    <footer className="status-bar flex min-w-0 flex-none items-center gap-x-3 overflow-hidden whitespace-nowrap border-t border-line px-3 text-s text-text-2 max-md:hidden">
      {stopped ? (
        <span role="status" className="flex min-w-0 items-center gap-1.5 font-semibold text-danger" title={STOPPED_TEXT}>
          <span aria-hidden="true" className="conn-dot" data-tone="red" />
          <span className="min-w-0 truncate">{STOPPED_TEXT}</span>
        </span>
      ) : notice ? (
        <span role="status" className="min-w-0 truncate font-semibold text-warning" title={notice}>
          키움 응답이 늦습니다
        </span>
      ) : (
        !publicMode && <ConnectionIndicator view={connection} short />
      )}
      <MarketClock />
      <SaveStatus />
      {!publicMode && <SyncIndicator />}
      <FinancialStatus />
      <span className="flex-1" />
      <Attribution text="Charts by TradingView" className="flex-none text-xs text-text-2 hover:text-text" />
    </footer>
  );
}
