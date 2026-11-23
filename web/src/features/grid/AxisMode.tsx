import { useRef, useState } from "react";
import { shownScale, type PriceScale } from "../../chart/settings";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useActionKeys } from "../../stores/ui";
import { shortcutOf } from "../../lib/hotkeys";
import { AXIS_LOCKED } from "../indicator-dialog/compareForm";
import { Menu } from "../menu/Menu";
import { ChevronIcon } from "../icons";
import type { WindowId } from "../../layout/kinds";

interface ScaleOption { value: PriceScale; label: string; hint: string; action?: string }

const OPTIONS: readonly ScaleOption[] = [
  { value: "normal", label: "일반", hint: "가격 그대로" },
  { value: "log", label: "로그", hint: "로그 축", action: "toggleLog" },
  { value: "percent", label: "%", hint: "왼쪽 끝 봉 기준" },
];

export function AxisMode({ cellId, corner }: { cellId: WindowId; corner: { width: number; height: number } }) {
  const settings = useCell(cellId).chartSettings;
  const keys = useActionKeys();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const locked = settings.compare.length > 0;
  const value = shownScale(settings);
  const items = OPTIONS.map((option) => ({
    kind: "radio" as const, label: option.label, hint: option.hint, value: option.value, checked: option.value === value,
    shortcut: option.action ? shortcutOf(keys, option.action) : undefined,
    onSelect: () => useLayoutStore.getState().setScale(cellId, option.value),
  }));
  return <div data-chart-control className="absolute bottom-0 right-0 z-[6] flex items-center justify-center max-md:hidden" style={{ width: corner.width, height: corner.height }}>
    <span ref={root} className="inline-flex min-w-0">
      <button type="button" role="combobox" aria-label="가격축 방식" aria-haspopup="menu" aria-expanded={open} disabled={locked} title={locked ? AXIS_LOCKED : undefined} data-value={value} className="inline-flex h-6 items-center justify-between gap-1 rounded-s px-1.5 text-xs text-text-2 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent" onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}><span>{OPTIONS.find((o) => o.value === value)?.label}</span><span className="inline-flex rotate-180"><ChevronIcon /></span></button>
      {open && <Menu label="가격축 방식" root={root} items={items} placement="top" onClose={() => setOpen(false)} />}
    </span>
  </div>;
}
