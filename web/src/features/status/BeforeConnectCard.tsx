import { openSystemSettings } from "../system-settings/open";
import { type BeforeConnect, OPEN_SETTINGS_LABEL } from "./beforeConnect";
import { actionView, waitText } from "./linkAction";
import { useConnectKiwoom } from "./useConnectKiwoom";
import { useServerTime } from "./useServerTime";

export function OpenSettingsButton({ className = "btn-primary", label = OPEN_SETTINGS_LABEL }: { className?: string; label?: string }) {
  return (
    <button type="button" className={className} onClick={() => openSystemSettings("kiwoom")}>
      {label}
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
  return notice.canOpenSettings ? <OpenSettingsButton className={className} label={notice.settingsLabel} /> : null;
}

function Waiting({ retryAt }: { retryAt: number | null }) {
  return <p className="text-m text-text-2">{waitText(retryAt, useServerTime())}</p>;
}

export function BeforeConnectCard({ notice }: { notice: BeforeConnect }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[15] grid place-items-center p-4">
      <section aria-label="키움 연결 안내" className="pointer-events-auto flex w-[min(440px,100%)] flex-col items-center gap-2 rounded-m border border-line bg-surface px-5 py-4 text-center shadow-[var(--shadow-s)]">
        <h3 className="text-l font-semibold text-text">{notice.title}</h3>
        {notice.waitingUntil ? <Waiting retryAt={notice.waitingUntil.retryAt} /> : <p className="line-clamp-2 text-m text-text-2" title={notice.detail}>{notice.detail}</p>}
        {notice.steps.length > 0 && (
          <ol aria-label="시작 순서" className="flex w-full flex-col gap-2 py-1 text-left">
            {notice.steps.map((step, index) => (
              <li key={step.title} className="flex items-start gap-3">
                <span aria-hidden="true" className="grid h-6 w-6 flex-none place-items-center rounded-m bg-raised text-s font-semibold text-text">{index + 1}</span>
                <span className="min-w-0"><span className="block text-m font-semibold text-text">{step.title}</span><span className="block text-s text-text-2">{step.body}</span></span>
              </li>
            ))}
          </ol>
        )}
        {notice.next && <p className="text-m text-text">{notice.next}</p>}
        {notice.note && <p className="text-s text-text-3">{notice.note}</p>}
        <BeforeConnectButton notice={notice} />
      </section>
    </div>
  );
}
