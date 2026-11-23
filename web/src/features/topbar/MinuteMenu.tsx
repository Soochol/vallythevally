import { useRef, useState } from "react";
import type { Period } from "../../api/generated/Period";
import { isMinutePeriod, MINUTE_PERIODS, PERIOD_LABEL } from "../../lib/symbol";
import { matchHotkey, periodActionId, shortcutOf } from "../../lib/hotkeys";
import { useMarketSource } from "../../stores/kiwoomLink";
import { useActionKeys, useUiStore } from "../../stores/ui";
import { CheckIcon, ChevronIcon } from "../icons";
import { Popover } from "../overlay/Popover";
import { menuIndex } from "../overlay/position";
import { marketFeatureOn } from "../status/marketFeed";

export const NO_MINUTE_BARS_NOTE = "이 시세 공급원은 분봉을 주지 않습니다";

export function MinuteMenu({ value, onChange }: { value: Period; onChange(value: Period): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastMinute = useUiStore((s) => s.prefs.lastMinute);
  const keys = useActionKeys();
  const minute = isMinutePeriod(value);
  const offered = marketFeatureOn(useMarketSource(), "minuteBars");
  const choose = (period: Period) => { if (!offered) return; onChange(period); setOpen(false); };
  return <>
    <button ref={trigger} type="button" className={offered ? "seg-btn inline-flex items-center gap-1" : "seg-btn inline-flex items-center gap-1 opacity-40"} aria-disabled={offered ? undefined : true} title={offered ? undefined : NO_MINUTE_BARS_NOTE} aria-label="분봉" data-value={minute ? value : ""} aria-haspopup="menu" aria-expanded={open} aria-pressed={minute} onClick={() => minute || !offered ? setOpen(!open) : onChange(lastMinute)}>{PERIOD_LABEL[minute ? value : lastMinute]}<ChevronIcon /></button>
    {open && <Popover anchor={trigger} onClose={() => setOpen(false)} role="menu" aria-label="분봉" className="minute-menu" onKeyDown={(e) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
        const index = buttons.findIndex((b) => b === document.activeElement);
        buttons[menuIndex(buttons.map((b) => b.textContent ?? ""), index, e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key)]?.focus();
      } else {
        const action = matchHotkey(e, "desktop", keys);
        if (action?.kind === "period" && isMinutePeriod(action.period)) {
          e.preventDefault(); e.stopPropagation(); choose(action.period);
        }
      }
    }}>
      {!offered && <p role="note" className="px-2 py-1 text-xs text-text-3">{NO_MINUTE_BARS_NOTE}</p>}
      {MINUTE_PERIODS.map((p) => <button key={p} type="button" role="menuitemradio" data-option-value={p} aria-checked={value === p} aria-disabled={offered ? undefined : true} className={offered ? undefined : "opacity-40"} aria-keyshortcuts={shortcutOf(keys, periodActionId(p))} onClick={() => choose(p)}>
        <CheckIcon /><span>{PERIOD_LABEL[p]}</span>{shortcutOf(keys, periodActionId(p)) && <kbd aria-hidden="true">{shortcutOf(keys, periodActionId(p))}</kbd>}
      </button>)}
    </Popover>}
  </>;
}
