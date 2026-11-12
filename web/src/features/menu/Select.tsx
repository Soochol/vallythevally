import { useRef, useState } from "react";
import { Menu, type MenuItem } from "./Menu";
import { ChevronIcon } from "../icons";
export interface SelectOption<T extends string | number> { value: T; label: string; group?: string }
export function Select<T extends string | number>({ label, value, options, onChange, className = "", defaultOpen = false }: { label: string; value: T; options: readonly SelectOption<T>[]; onChange(value: T): void; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLSpanElement>(null);
  const items: MenuItem[] = [];
  let group: string | undefined;
  for (const option of options) {
    if (option.group !== group) { group = option.group; if (group) items.push({ kind: "heading", label: group }); }
    items.push({ kind: "radio", label: option.label, value: String(option.value), checked: option.value === value, onSelect: () => onChange(option.value) });
  }
  return <span ref={root} className="inline-flex min-w-0">
    <button type="button" role="combobox" aria-label={label} aria-haspopup="menu" aria-expanded={open} data-value={value} className={`inline-flex items-center justify-between gap-1 ${className}`} onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); } }}><span>{options.find((o) => o.value === value)?.label}</span><ChevronIcon /></button>
    {open && <Menu label={label} root={root} items={items} onClose={() => setOpen(false)} />}
  </span>;
}
