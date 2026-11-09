import { useEffect, useState } from "react";
import { useRealtimeStore } from "../../stores/realtime";
import { type ConnectionView, connectionView } from "./connectionView";

/** 장 닫힘은 시각으로 판단하므로 연결이 그대로여도 문장이 바뀐다. */
const CLOCK_TICK_MS = 30_000;

export function useConnectionView(): ConnectionView {
  const connection = useRealtimeStore((s) => s.connection);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return connectionView(connection, now);
}

/** 연결 상태 점과 문장(frontend.md §2.2). */
export function ConnectionIndicator({ view, className = "" }: { view: ConnectionView; className?: string }) {
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <span aria-hidden="true" className="conn-dot" data-tone={view.tone} data-pulse={view.pulse || undefined} />
      <span className={`truncate ${view.tone === "red" ? "font-[650] text-up" : ""}`}>{view.text}</span>
    </span>
  );
}
