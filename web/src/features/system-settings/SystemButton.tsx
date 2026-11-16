import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { GearIcon } from "../icons";
import { linkDotTone } from "./linkDot";
import { openSystemSettings } from "./open";

export function SystemButton() {
  const tone = linkDotTone(useKiwoomLinkStore((s) => s.status));
  return (
    <button type="button" className="tb-btn" aria-haspopup="dialog" aria-label="시스템 설정" title="시스템 설정 (Alt+,)" onClick={() => openSystemSettings()}>
      <GearIcon />
      <span className="max-xl:hidden">시스템</span>
      <span aria-hidden="true" className="conn-dot" data-tone={tone} />
    </button>
  );
}

export function PhoneSystemButton() {
  return (
    <button type="button" className="icon-btn h-9 w-9 flex-none" aria-haspopup="dialog" aria-label="시스템 설정" title="시스템 설정" onClick={() => openSystemSettings()}>
      <GearIcon size={20} />
    </button>
  );
}
