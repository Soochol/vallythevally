import { useKiwoomStore } from "../../stores/kiwoom";
import { openSystemSettings } from "../system-settings/open";
import { Attribution } from "./attribution";
import { ConnectionIndicator, useConnectionView } from "./ConnectionIndicator";
import { FinancialStatus } from "./FinancialStatus";
import { MarketClock } from "./MarketClock";
import { SaveStatus } from "./SaveStatus";

export function StatusBar() {
  const stopped = useKiwoomStore((s) => s.stopped);
  const notice = useKiwoomStore((s) => s.notice);
  const connection = useConnectionView();
  const halted = !stopped && !notice && connection.tone === "red";
  return (
    <footer
      className={`status-bar flex min-w-0 flex-none items-center gap-x-3 overflow-hidden whitespace-nowrap border-t border-line px-3 text-xs text-text-2 max-md:hidden ${halted ? "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]" : ""}`}
    >
      {stopped ? (
        <span role="alert" className="flex min-w-0 items-center gap-2 font-[650] text-danger">
          <span className="min-w-0 truncate" title={stopped}>키움 조회 멈춤: {stopped}</span>
          <button type="button" className="flex-none underline underline-offset-2" onClick={() => openSystemSettings("kiwoom")}>시스템 설정 열기</button>
        </span>
      ) : notice ? (
        <span role="status" className="min-w-0 truncate font-[650] text-warning" title={notice}>
          {notice}
        </span>
      ) : (
        <ConnectionIndicator view={connection} />
      )}
      <MarketClock />
      <SaveStatus />
      <FinancialStatus />
      <span className="flex-1" />
      <Attribution icon className="flex flex-none items-center text-text-2 hover:text-text" />
    </footer>
  );
}
