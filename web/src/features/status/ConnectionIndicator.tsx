import { useKiwoomLinkStore, useSourceBroker } from "../../stores/kiwoomLink";
import { BROKERS } from "../system-settings/brokers";
import { useRealtimeStore } from "../../stores/realtime";
import { openSystemSettings } from "../system-settings/open";
import { type ConnectionView, connectionView } from "./connectionView";
import { countsDownSeconds } from "./linkAction";
import { STATUS_BUTTON } from "./statusButton";
import { useConnectKiwoom } from "./useConnectKiwoom";
import { useServerTime } from "./useServerTime";

export function useConnectionView(): ConnectionView {
  const connection = useRealtimeStore((s) => s.connection);
  const link = useKiwoomLinkStore((s) => s.status);
  const now = useServerTime(countsDownSeconds(link) ? "second" : "minute");
  return connectionView(connection, now, link, useSourceBroker());
}

export const shortConnectionText = (view: ConnectionView): string => (view.tone === "red" ? view.text.split(":")[0]! : view.text);

/** 연결 상태 점과 문장, 바로 연결 단추(frontend.md §2.2). */
export function ConnectionIndicator({ view, short = false, className = "" }: { view: ConnectionView; short?: boolean; className?: string }) {
  const { busy, error, connect } = useConnectKiwoom();
  const name = BROKERS[useSourceBroker()].shortName;
  const text = short ? shortConnectionText(view) : view.text;
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-s hover:text-text" title={`${name} 연결 설정 열기`} onClick={() => openSystemSettings("kiwoom")}>
        <span aria-hidden="true" className="conn-dot" data-tone={view.tone} data-pulse={view.pulse || undefined} />
        <span className={`truncate ${view.tone === "red" ? "font-semibold text-danger" : ""}`}>{text}</span>
      </button>
      {view.action && (
        <button type="button" aria-label={view.action.kind === "connect" ? `${name}에 연결` : undefined} title={error ?? undefined} className={STATUS_BUTTON} disabled={!view.action.enabled || busy} onClick={connect}>
          {view.action.label}
        </button>
      )}
    </span>
  );
}
