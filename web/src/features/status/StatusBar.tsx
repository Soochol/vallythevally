import { useKiwoomStore } from "../../stores/kiwoom";
import { Attribution } from "./attribution";
import { SaveStatus } from "./SaveStatus";

export function StatusBar() {
  const stopped = useKiwoomStore((s) => s.stopped);
  const notice = useKiwoomStore((s) => s.notice);
  return (
    <footer className="flex min-w-0 items-center gap-4 border-t border-line bg-bg px-3 text-xs text-text-2 [grid-area:status] max-md:hidden">
      {stopped ? (
        <span role="alert" className="min-w-0 truncate font-[650] text-accent" title={stopped}>
          키움 조회 멈춤: {stopped}
        </span>
      ) : notice ? (
        <span role="status" className="min-w-0 truncate font-[650] text-accent" title={notice}>
          {notice}
        </span>
      ) : (
        <span title="실시간 연결이 없습니다. 종목이나 봉 주기를 바꿀 때 키움에서 조회합니다.">조회 모드</span>
      )}
      <SaveStatus />
      <span className="flex-1" />
      <Attribution text="Charts by TradingView Lightweight Charts™" className="text-text-2 underline underline-offset-2" />
    </footer>
  );
}
