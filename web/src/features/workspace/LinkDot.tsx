import { useRef, useState } from "react";
import { useSymbolInfo } from "../../api/queries";
import { WINDOW_KINDS } from "../../layout/kinds";
import { isFollowsWindow, isPinnableWindow, isWindowLocked, linkedWindowSymbol, linkLabel, useLayoutStore, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { LinkSwatchMenu } from "./LinkSwatchMenu";

export function LinkDot({ window, selected }: { window: WindowState; selected: boolean }) {
  const dot = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const lockedWindows = useLayoutStore((s) => s.lockedWindows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const code = useLayoutStore((s) =>
    window.kind === "chart" ? window.symbol : linkedWindowSymbol(s.layout, window.id, activeCell, s.groupSymbols),
  );
  const name = useSymbolInfo(code ?? "005930").data?.name ?? code ?? "";
  if (WINDOW_KINDS[window.kind].link === "none") return null;
  const value = window.link === null ? "끔" : linkLabel(window.link);
  const locked = isFollowsWindow(window) && (isWindowLocked(window, lockedWindows) || (isPinnableWindow(window) && window.symbol !== undefined));
  const title = locked ? `연동 색: ${value} · 종목 고정됨 (${name}) · 눌러서 고르기` : `연동 색: ${value} · 눌러서 고르기`;
  const ariaLabel = locked ? `연동 색: ${value} · 종목 고정됨` : `연동 색: ${value}`;
  return (
    <>
      <button ref={dot} type="button" className="link-dot" tabIndex={selected ? 0 : -1} data-link={window.link ?? undefined} data-locked={locked ? "" : undefined} aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} title={title}
        onClick={() => setOpen((now) => !now)}>
        {window.link !== null && <span aria-hidden="true">{value}</span>}
        {locked && <span className="link-dot-lock" aria-hidden="true" />}
      </button>
      {open && <LinkSwatchMenu window={window} dot={dot} onClose={() => setOpen(false)} />}
    </>
  );
}
