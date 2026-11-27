import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { GearIcon, WarningIcon } from "../icons";
import { linkDotTone } from "./linkDot";
import { keyTitle } from "../../lib/hotkeys";
import { useActionKeys } from "../../stores/ui";
import { systemButtonSentence } from "./kiwoomKeys";
import { openSystemSettings } from "./open";
import "./system-settings.css";

export function SystemButton() {
  const status = useKiwoomLinkStore((s) => s.status);
  const tone = linkDotTone(status);
  const keys = useActionKeys();
  return (
    <button type="button" className="page-rail-item system-btn relative" aria-haspopup="dialog" aria-label="시스템 설정" title={`${keyTitle("시스템 설정", keys, "systemSettings")} · ${systemButtonSentence(status)}`} onClick={() => openSystemSettings()}>
      <GearIcon size={19} />
      <span>시스템</span>
      {tone === "red" || tone === "amber" ? <span aria-hidden="true" className="conn-flag" data-tone={tone}><WarningIcon size={12} /></span> : <span aria-hidden="true" className="conn-dot" data-tone={tone} />}
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
