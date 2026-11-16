import { useRealtimeStore } from "../../stores/realtime";
import { openSystemSettings } from "../system-settings/open";
import { type ConnectionView, connectionView } from "./connectionView";
import { useServerTime } from "./useServerTime";

export function useConnectionView(): ConnectionView {
  const connection = useRealtimeStore((s) => s.connection);
  const now = useServerTime();
  return connectionView(connection, now);
}

/** 연결 상태 점과 문장(frontend.md §2.2). */
export function ConnectionIndicator({ view, className = "" }: { view: ConnectionView; className?: string }) {
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-s hover:text-text" title="키움 연결 설정 열기" onClick={() => openSystemSettings("kiwoom")}>
        <span aria-hidden="true" className="conn-dot" data-tone={view.tone} data-pulse={view.pulse || undefined} />
        <span className={`truncate ${view.tone === "red" ? "font-[650] text-danger" : ""}`}>{view.text}</span>
      </button>
    </span>
  );
}
