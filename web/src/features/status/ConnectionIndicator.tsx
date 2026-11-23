import { useKiwoomLinkStore, useSourceBroker } from "../../stores/kiwoomLink";
import { BROKERS } from "../system-settings/brokers";
import { useRealtimeStore } from "../../stores/realtime";
import { openSystemSettings } from "../system-settings/open";
import { type ConnectionView, connectionView } from "./connectionView";
import { useConnectKiwoom } from "./useConnectKiwoom";
import { useServerTime } from "./useServerTime";

export function useConnectionView(): ConnectionView {
  const connection = useRealtimeStore((s) => s.connection);
  const link = useKiwoomLinkStore((s) => s.status);
  const now = useServerTime();
  return connectionView(connection, now, link, useSourceBroker());
}

/** 연결 상태 점과 문장, 바로 연결 단추(frontend.md §2.2). */
export function ConnectionIndicator({ view, className = "" }: { view: ConnectionView; className?: string }) {
  const { busy, error, connect } = useConnectKiwoom();
  const name = BROKERS[useSourceBroker()].shortName;
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-s hover:text-text" title={`${name} 연결 설정 열기`} onClick={() => openSystemSettings("kiwoom")}>
        <span aria-hidden="true" className="conn-dot" data-tone={view.tone} data-pulse={view.pulse || undefined} />
        <span className={`truncate ${view.tone === "red" ? "font-[650] text-danger" : ""}`}>{view.text}</span>
      </button>
      {view.action && (
        <button type="button" aria-label={view.action.kind === "connect" ? `${name}에 연결` : undefined} title={error ?? undefined} className="tb-btn h-5 flex-none px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50" disabled={!view.action.enabled || busy} onClick={connect}>
          {view.action.label}
        </button>
      )}
    </span>
  );
}
