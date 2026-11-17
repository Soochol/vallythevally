import { useRef, useState } from "react";
import { WINDOW_KINDS } from "../../layout/kinds";
import { linkLabel, type WindowState } from "../../stores/layout";
import { LinkSwatchMenu } from "./LinkSwatchMenu";

export function LinkDot({ window, selected }: { window: WindowState; selected: boolean }) {
  const dot = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (WINDOW_KINDS[window.kind].link === "none") return null;
  const value = window.link === null ? "끔" : linkLabel(window.link);
  return (
    <>
      <button ref={dot} type="button" className="link-dot" tabIndex={selected ? 0 : -1} data-link={window.link ?? undefined} aria-label={`연동 색: ${value}`} aria-haspopup="menu" aria-expanded={open} title={`연동 색: ${value} · 눌러서 고르기`}
        onClick={() => setOpen((now) => !now)}>
        {window.link !== null && <span aria-hidden="true">{value}</span>}
      </button>
      {open && <LinkSwatchMenu window={window} dot={dot} onClose={() => setOpen(false)} />}
    </>
  );
}
