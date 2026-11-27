import { useRef, useState } from "react";
import { usePublicMode } from "../../public-mode/serverMode";
import { useKiwoomStore } from "../../stores/kiwoom";
import { Popover } from "../overlay/Popover";
import { WarningIcon } from "../icons";
import { openSystemSettings } from "../system-settings/open";
import { useConnectionView } from "./ConnectionIndicator";
import { retryAll, saveFailureText, useSaveView } from "./SaveStatus";

type BannerTone = "warning" | "danger";

interface Banner {
  id: string;
  tone: BannerTone;
  text: string;
  detail: string | null;
  action: { label: string; run(): void } | null;
}

const TONE_FACE: Record<BannerTone, { face: string; icon: string }> = {
  warning: { face: "border-warning bg-[color-mix(in_srgb,var(--warning)_24%,var(--surface))]", icon: "text-warning" },
  danger: { face: "border-danger bg-[color-mix(in_srgb,var(--danger)_24%,var(--surface))]", icon: "text-danger" },
};

function useBanner(): Banner | null {
  const stopped = useKiwoomStore((s) => s.stopped);
  const publicMode = usePublicMode();
  const connection = useConnectionView();
  const { indicator, offline } = useSaveView();
  if (offline) {
    return { id: "offline", tone: "warning", text: "서버에 닿지 못해 기본 화면으로 열었습니다. 바꾼 것은 저장되지 않습니다", detail: offline, action: { label: "다시 불러오기", run: () => location.reload() } };
  }
  if (stopped) {
    return { id: "stopped", tone: "danger", text: "키움 조회가 멈췄습니다. 시스템 설정에서 확인하세요", detail: stopped, action: { label: "시스템 설정 열기", run: () => openSystemSettings("kiwoom") } };
  }
  if (!publicMode && connection.tone === "red") {
    return { id: "connection", tone: "danger", text: connection.text, detail: null, action: null };
  }
  const failure = saveFailureText(indicator);
  if (failure) {
    return { id: "save", tone: "warning", text: failure, detail: null, action: indicator.kind === "failed" ? { label: "다시 시도", run: retryAll } : null };
  }
  return null;
}

function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className="btn-ghost btn-sm flex-none" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>자세히</button>
      {open && (
        <Popover anchor={anchor} role="dialog" aria-label="자세히" placement="bottom" onClose={() => setOpen(false)} className="max-w-[420px] p-3 text-s">
          <p className="break-words">{text}</p>
        </Popover>
      )}
    </>
  );
}

export function ShellBanner() {
  const banner = useBanner();
  if (!banner) return null;
  return (
    <div role="alert" data-testid="shell-banner" data-banner={banner.id} className={`absolute inset-x-3 top-[calc(var(--island-gap)+var(--island-h)+var(--s1))] z-[var(--z-banner)] flex min-h-8 items-center gap-2 rounded-m border px-3 py-1 text-s text-text shadow-[var(--shadow-s)] max-md:inset-x-2 max-md:top-[calc(var(--size-48)+var(--s1))] ${TONE_FACE[banner.tone].face}`}>
      <span aria-hidden="true" className={`flex flex-none ${TONE_FACE[banner.tone].icon}`}><WarningIcon size={14} /></span>
      <span className="min-w-0 flex-1 truncate" title={banner.text}>{banner.text}</span>
      {banner.detail && <Details text={banner.detail} />}
      {banner.action && <button type="button" className="btn btn-sm flex-none" onClick={banner.action.run}>{banner.action.label}</button>}
    </div>
  );
}
