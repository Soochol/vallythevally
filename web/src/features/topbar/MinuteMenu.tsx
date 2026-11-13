import { useRef, useState } from "react";
import type { Period } from "../../api/generated/Period";
import { isMinutePeriod, MINUTE_PERIODS, PERIOD_LABEL } from "../../lib/symbol";
import { matchHotkey, periodKey } from "../../lib/hotkeys";
import { useUiStore } from "../../stores/ui";
import { CheckIcon, ChevronIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { menuIndex } from "../overlay/position";
export function MinuteMenu({ value, onChange }: { value: Period; onChange(value: Period): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastMinute = useUiStore((s) => s.prefs.lastMinute);
  const minute = isMinutePeriod(value);
  const choose = (period: Period) => { onChange(period); setOpen(false); };
  return <>
    <button ref={trigger} type="button" className="seg-btn inline-flex items-center gap-1" aria-label="분봉" data-value={minute ? value : ""} aria-haspopup="menu" aria-expanded={open} aria-pressed={minute} onClick={() => minute ? setOpen(!open) : onChange(lastMinute)}>{PERIOD_LABEL[minute ? value : lastMinute]}<ChevronIcon /></button>
    {open && <Popover anchor={trigger} onClose={() => setOpen(false)} role="menu" aria-label="분봉" className="minute-menu" onKeyDown={(e) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
        const index = buttons.findIndex((b) => b === document.activeElement);
        buttons[menuIndex(buttons.map((b) => b.textContent ?? ""), index, e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key)]?.focus();
      } else {
        const action = matchHotkey(e, "desktop");
        if (action?.kind === "period" && isMinutePeriod(action.period)) {
          e.preventDefault(); e.stopPropagation(); choose(action.period);
        }
      }
    }}>
      {MINUTE_PERIODS.map((p) => <button key={p} type="button" role="menuitemradio" data-option-value={p} aria-checked={value === p} aria-keyshortcuts={periodKey(p)} onClick={() => choose(p)}>
        <CheckIcon /><span>{PERIOD_LABEL[p]}</span>{periodKey(p) && <kbd aria-hidden="true">{periodKey(p)}</kbd>}
      </button>)}
    </Popover>}
  </>;
}
