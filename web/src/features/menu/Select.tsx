import { type ReactNode, useId, useRef, useState } from "react";
import { Menu, type MenuItem } from "./Menu";
import { ChevronIcon } from "../icons";
import type { Placement } from "../overlay/position";
export interface SelectOption<T extends string | number> { value: T; label: string; icon?: ReactNode; group?: string; hint?: string; shortcut?: string; disabled?: boolean }
export function Select<T extends string | number>({ label, value, options, onChange, className = "", defaultOpen = false, disabled = false, title, placement }: { label: string; value: T; options: readonly SelectOption<T>[]; onChange(value: T): void; className?: string; defaultOpen?: boolean; disabled?: boolean; title?: string; placement?: Placement }) {
  const [open, setOpen] = useState(defaultOpen);
  const menuId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const items: MenuItem[] = [];
  let group: string | undefined;
  for (const option of options) {
    if (option.group !== group) { group = option.group; if (group) items.push({ kind: "heading", label: group }); }
    items.push({ kind: "radio", label: option.label, icon: option.icon, hint: option.hint, shortcut: option.shortcut, disabled: option.disabled, value: String(option.value), checked: option.value === value, onSelect: () => onChange(option.value) });
  }
  const current = options.find((o) => o.value === value);
  return <span ref={root} className="inline-flex min-w-0">
    <button type="button" role="combobox" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} title={title} data-value={value} className={`inline-flex items-center justify-between gap-1 disabled:cursor-not-allowed disabled:opacity-50 ${className}`} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}><span className={current?.icon ? "inline-flex items-center gap-1.5" : undefined}>{current?.icon}{current?.label}</span>{placement === "top" ? <span className="inline-flex rotate-180"><ChevronIcon /></span> : <ChevronIcon />}</button>
    {open && <Menu id={menuId} label={label} root={root} items={items} placement={placement} onClose={() => setOpen(false)} />}
  </span>;
}
