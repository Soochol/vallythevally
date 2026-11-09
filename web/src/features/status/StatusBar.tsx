import { CHART_CREDIT } from "../../chart/snapshot";
import { useKiwoomStore } from "../../stores/kiwoom";
import { Attribution } from "./attribution";
import { ConnectionIndicator, useConnectionView } from "./ConnectionIndicator";
import { SaveStatus } from "./SaveStatus";

export function StatusBar() {
  const stopped = useKiwoomStore((s) => s.stopped);
  const notice = useKiwoomStore((s) => s.notice);
  const connection = useConnectionView();
  const halted = !stopped && !notice && connection.tone === "red";
  return (
    <footer
      className={`flex min-w-0 items-center gap-4 border-t border-line px-3 text-xs text-text-2 [grid-area:status] max-md:hidden ${
        halted ? "bg-[color-mix(in_srgb,var(--up)_14%,var(--bg))]" : "bg-bg"
      }`}
    >
      {stopped ? (
        <span role="alert" className="min-w-0 truncate font-[650] text-accent" title={stopped}>
          키움 조회 멈춤: {stopped}
        </span>
      ) : notice ? (
        <span role="status" className="min-w-0 truncate font-[650] text-accent" title={notice}>
          {notice}
        </span>
      ) : (
        <ConnectionIndicator view={connection} />
      )}
      <SaveStatus />
      <span className="flex-1" />
      <Attribution text={CHART_CREDIT} className="text-text-2 underline underline-offset-2" />
    </footer>
  );
}
