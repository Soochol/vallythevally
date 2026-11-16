import { openSystemSettings } from "../system-settings/open";
import type { BeforeConnect } from "./beforeConnect";

export function OpenSettingsButton({ className = "btn-primary" }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => openSystemSettings("kiwoom")}>
      시스템 설정 열기
    </button>
  );
}

export function BeforeConnectCard({ notice }: { notice: BeforeConnect }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center p-4">
      <section aria-label="키움 연결 안내" className="pointer-events-auto flex w-[min(360px,100%)] flex-col items-center gap-2 rounded-m border border-line bg-surface px-5 py-3 text-center shadow-dialog">
        <h3 className="text-l font-[650] text-text">{notice.title}</h3>
        <p className="line-clamp-2 text-s text-text-2" title={notice.detail}>{notice.detail}</p>
        {notice.canOpenSettings && <OpenSettingsButton />}
      </section>
    </div>
  );
}
