import { type ReactNode, useRef, useState } from "react";
import { Menu, type MenuItem } from "../menu/Menu";

export function ScreenerMenu({ label, children, items }: { label: string; children: ReactNode; items: readonly MenuItem[] }) {
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return <span ref={root} className="inline-flex min-w-0">
    <button type="button" data-chart-control aria-label={label} aria-haspopup="menu" aria-expanded={open} className="tb-btn min-w-0 gap-1 px-1 text-s" onClick={() => setOpen(!open)}>{children}</button>
    {open && <Menu label={label} root={root} items={items} className="max-h-[60vh] overflow-auto" onClose={() => setOpen(false)} />}
  </span>;
}
