import { openSystemSettings } from "../system-settings/open";
import type { BeforeConnect } from "./beforeConnect";
import { actionView, waitText } from "./linkAction";
import { useConnectKiwoom } from "./useConnectKiwoom";
import { useServerTime } from "./useServerTime";

export function OpenSettingsButton({ className = "btn-primary" }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => openSystemSettings("kiwoom")}>
      시스템 설정 열기
    </button>
  );
}

export function BeforeConnectButton({ notice, className = "btn-primary" }: { notice: BeforeConnect; className?: string }) {
  const { busy, error, connect } = useConnectKiwoom();
  const now = useServerTime();
  if (notice.action) {
    const view = actionView(notice.action, now);
    return (
      <>
        <button type="button" className={`${className} disabled:cursor-not-allowed disabled:opacity-50`} disabled={!view.enabled || busy} onClick={connect}>{view.label}</button>
        {error && <p role="alert" className="text-s text-danger">{error}</p>}
      </>
    );
  }
  return notice.canOpenSettings ? <OpenSettingsButton className={className} /> : null;
}

function Waiting({ retryAt }: { retryAt: number | null }) {
  return <p className="text-s text-text-2">{waitText(retryAt, useServerTime())}</p>;
}

export function BeforeConnectCard({ notice }: { notice: BeforeConnect }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-4">
      <section aria-label="키움 연결 안내" className="pointer-events-auto flex w-[min(360px,100%)] flex-col items-center gap-2 rounded-m border border-line bg-surface px-5 py-3 text-center shadow-dialog">
        <h3 className="text-l font-[650] text-text">{notice.title}</h3>
        {notice.waitingUntil ? <Waiting retryAt={notice.waitingUntil.retryAt} /> : <p className="line-clamp-2 text-s text-text-2" title={notice.detail}>{notice.detail}</p>}
        {notice.note && <p className="text-s text-text-3">{notice.note}</p>}
        <BeforeConnectButton notice={notice} />
      </section>
    </div>
  );
}
