import { Attribution } from "./attribution";
import { SaveStatus } from "./SaveStatus";

/** 아래 상태 줄. WebSocket이 없으므로(#4 전) 연결 상태 점 없이 `조회 모드`라고 적고, 그 옆에 자동 저장 표시를 둔다. */
export function StatusBar() {
  return (
    <footer className="flex min-w-0 items-center gap-4 border-t border-line bg-bg px-3 text-xs text-text-2 [grid-area:status] max-md:hidden">
      <span title="실시간 연결이 없습니다. 종목이나 봉 주기를 바꿀 때 키움에서 조회합니다.">조회 모드</span>
      <SaveStatus />
      <span className="flex-1" />
      <Attribution text="Charts by TradingView Lightweight Charts™" className="text-text-2 underline underline-offset-2" />
    </footer>
  );
}
