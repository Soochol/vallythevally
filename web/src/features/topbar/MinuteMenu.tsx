import { useRef, useState } from "react";
import type { Period } from "../../api/generated/Period";
import { PERIODS, PERIOD_LABEL } from "../../lib/symbol";
import { matchHotkey, periodKey } from "../../lib/hotkeys";
import { useUiStore } from "../../stores/ui";
import { ChevronIcon, StarIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { menuIndex } from "../overlay/position";
export const MINUTES = PERIODS.filter((p) => p.endsWith("m"));
export function MinuteMenu({ value, onChange }: { value: Period; onChange(value: Period): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pinned = useUiStore((s) => s.prefs.pinnedMinutes);
  return <>
    <button ref={trigger} className="seg-btn inline-flex items-center gap-1" aria-label="분봉" data-value={value.endsWith("m") ? value : ""} aria-haspopup="menu" aria-expanded={open} aria-pressed={value.endsWith("m")} onClick={() => setOpen(!open)}>{value.endsWith("m") ? PERIOD_LABEL[value] : "분봉"}<ChevronIcon /></button>
    {pinned.map((p) => <button key={p} className="seg-btn" aria-label={`${PERIOD_LABEL[p]} 고정 주기`} aria-pressed={value === p} title={`${PERIOD_LABEL[p]} (${periodKey(p)})`} onClick={() => onChange(p)}>{PERIOD_LABEL[p]}</button>)}
    {open && <Popover anchor={trigger} onClose={() => setOpen(false)} role="menu" aria-label="분봉" className="minute-menu" onKeyDown={(e) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
        const index = buttons.findIndex((b) => b === document.activeElement);
        buttons[menuIndex(buttons.map((b) => b.textContent ?? ""), index, e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key)]?.focus();
      } else {
        const action = matchHotkey(e, "desktop");
        if (action?.kind === "period" && action.period.endsWith("m")) {
          e.preventDefault(); e.stopPropagation(); onChange(action.period); setOpen(false);
        }
      }
    }}>
      <strong>분봉</strong><div className="minute-grid">{MINUTES.map((p) => <div key={p}>
        <button role="menuitemradio" data-option-value={p} aria-checked={value === p} onClick={() => { onChange(p); setOpen(false); }}>{PERIOD_LABEL[p]}</button>
        <button role="menuitemcheckbox" aria-label={`${PERIOD_LABEL[p]} 고정`} aria-checked={pinned.includes(p)} onClick={() => useUiStore.getState().togglePinnedMinute(p)}><StarIcon /></button>
      </div>)}</div><p>별표한 분봉은 위 막대에 고정됩니다.</p>
    </Popover>}
  </>;
}
