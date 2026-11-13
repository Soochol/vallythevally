import { CHART_CREDIT } from "../../chart/snapshot";
import { useKiwoomStore } from "../../stores/kiwoom";
import { Attribution } from "./attribution";
import { ConnectionIndicator, useConnectionView } from "./ConnectionIndicator";
import { FinancialStatus } from "./FinancialStatus";
import { MarketClock } from "./MarketClock";
import { SaveStatus } from "./SaveStatus";

export function StatusBar({ floating = false }: { floating?: boolean }) {
  const stopped = useKiwoomStore((s) => s.stopped);
  const notice = useKiwoomStore((s) => s.notice);
  const connection = useConnectionView();
  const halted = !stopped && !notice && connection.tone === "red";
  return (
    <footer
      className={`flex min-w-0 flex-none flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap px-3 py-2 text-xs text-text-2 max-md:hidden ${
        floating ? "ui-island absolute bottom-[5.5rem] left-[var(--island-gap)] z-10 max-w-[calc(100%-var(--island-gap)*2-6rem)] rounded-m" : "border-t border-line"
      } ${halted ? "bg-[color-mix(in_srgb,var(--danger)_14%,transparent)]" : ""}`}
    >
      {stopped ? (
        <span role="alert" className="min-w-0 truncate font-[650] text-danger" title={stopped}>
          키움 조회 멈춤: {stopped}
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
      <Attribution text={CHART_CREDIT} className="flex-none text-text-2 underline underline-offset-2" />
    </footer>
  );
}
