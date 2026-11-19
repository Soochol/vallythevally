import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo } from "../../api/queries";
import { isPinnableWindow, useLayoutStore, type WindowState } from "../../stores/layout";
import { CloseIcon } from "../icons";

function PinnedSymbol({ window, code, selected }: { window: WindowState; code: SymbolCode; selected: boolean }) {
  const name = useSymbolInfo(code).data?.name ?? code;
  return (
    <span className="window-symbol" data-pinned="">
      <span className="window-symbol-pin" aria-hidden="true" title={`종목 고정: ${name}`}>●</span>
      <button type="button" className="window-symbol-unpin" tabIndex={selected ? 0 : -1} aria-label="종목 고정 풀기" title="종목 고정 풀기" onClick={() => useLayoutStore.getState().pinSymbol(window.id, null)}><CloseIcon size={10} /></button>
    </span>
  );
}

export function WindowSymbol({ window, selected }: { window: WindowState; selected: boolean }) {
  return isPinnableWindow(window) && window.symbol !== undefined ? <PinnedSymbol window={window} code={window.symbol} selected={selected} /> : null;
}
