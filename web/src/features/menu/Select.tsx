import { useRef, useState } from "react";
import { Menu, type MenuItem } from "./Menu";
import { ChevronIcon } from "../icons";
import type { Placement } from "../overlay/position";
export interface SelectOption<T extends string | number> { value: T; label: string; group?: string; hint?: string }
export function Select<T extends string | number>({ label, value, options, onChange, className = "", defaultOpen = false, disabled = false, title, placement }: { label: string; value: T; options: readonly SelectOption<T>[]; onChange(value: T): void; className?: string; defaultOpen?: boolean; disabled?: boolean; title?: string; placement?: Placement }) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLSpanElement>(null);
  const items: MenuItem[] = [];
  let group: string | undefined;
  for (const option of options) {
    if (option.group !== group) { group = option.group; if (group) items.push({ kind: "heading", label: group }); }
    items.push({ kind: "radio", label: option.label, hint: option.hint, value: String(option.value), checked: option.value === value, onSelect: () => onChange(option.value) });
  }
  return <span ref={root} className="inline-flex min-w-0">
    <button type="button" role="combobox" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={title} data-value={value} className={`inline-flex items-center justify-between gap-1 disabled:cursor-not-allowed ${className}`} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}><span>{options.find((o) => o.value === value)?.label}</span>{placement === "top" ? <span className="inline-flex rotate-180"><ChevronIcon /></span> : <ChevronIcon />}</button>
    {open && <Menu label={label} root={root} items={items} placement={placement} onClose={() => setOpen(false)} />}
  </span>;
}
