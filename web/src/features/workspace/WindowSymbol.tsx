import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useSymbolInfo } from "../../api/queries";
import { isPinnableWindow, useLayoutStore, type WindowState } from "../../stores/layout";
import { CloseIcon } from "../icons";
import { useLinkedSymbol } from "../market-window/MarketWindowGate";
import { openPinPick } from "../search/pinPick";

function ShownSymbol({ window, code, selected }: { window: WindowState; code: SymbolCode; selected: boolean }) {
  const name = useSymbolInfo(code).data?.name ?? code;
  const pinned = isPinnableWindow(window) && window.symbol !== undefined;
  const tabIndex = selected ? 0 : -1;
  return (
    <span className="window-symbol" data-pinned={pinned ? "" : undefined}>
      <button type="button" className="dock-tab-sub window-symbol-name" tabIndex={tabIndex} title="종목 고르기" onClick={() => openPinPick(window.id)}>{name}</button>
      {pinned && <>
        <span className="window-symbol-pin" aria-hidden="true" title="종목 고정">●</span>
        <button type="button" className="window-symbol-unpin" tabIndex={tabIndex} aria-label="종목 고정 풀기" title="종목 고정 풀기" onClick={() => useLayoutStore.getState().pinSymbol(window.id, null)}><CloseIcon size={10} /></button>
      </>}
    </span>
  );
}

function FollowedSymbol({ window, selected }: { window: WindowState; selected: boolean }) {
  const code = useLinkedSymbol(window.id);
  return code === null ? null : <ShownSymbol window={window} code={code} selected={selected} />;
}

export function WindowSymbol({ window, selected }: { window: WindowState; selected: boolean }) {
  return isPinnableWindow(window) ? <FollowedSymbol window={window} selected={selected} /> : null;
}
