import { useSymbolInfo } from "../../api/queries";
import { isFollowsWindow, isPinnableWindow, isWindowLocked, linkedWindowSymbol, useLayoutStore, type WindowState } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { CloseIcon } from "../icons";

export function WindowSymbol({ window, selected }: { window: WindowState; selected: boolean }) {
  const lockedWindows = useLayoutStore((s) => s.lockedWindows);
  const activeCell = useSelectionStore((s) => s.activeCell);
  const code = useLayoutStore((s) =>
    window.kind === "chart" ? window.symbol : linkedWindowSymbol(s.layout, window.id, activeCell, s.groupSymbols),
  );
  const name = useSymbolInfo(code ?? "005930").data?.name ?? code ?? "";
  if (!isFollowsWindow(window)) return null;
  const locked = isWindowLocked(window, lockedWindows) || (isPinnableWindow(window) && window.symbol !== undefined);
  const toggle = () => useLayoutStore.getState().toggleWindowLock(window.id, activeCell);
  if (locked) {
    return (
      <span className="window-symbol" data-pinned="">
        <span className="window-symbol-pin" aria-hidden="true" title={`종목 고정: ${name}`}>🔒</span>
        <button type="button" className="window-symbol-unpin" tabIndex={selected ? 0 : -1} aria-label="종목 고정 풀기" title="종목 고정 풀기" onClick={toggle}><CloseIcon size={10} /></button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="window-symbol-unpin"
      tabIndex={selected ? 0 : -1}
      aria-label="종목 고정"
      title="종목 고정"
      onClick={toggle}
    >
      🔓
    </button>
  );
}
