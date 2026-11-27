import type { QueryClient } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { symbolInfoQuery } from "../../api/queries";
import { addSymbols } from "../../lib/watchlist";
import { type SymbolTarget, useLayoutStore, watchedSymbol } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import type { WindowId } from "../../layout/kinds";

interface ResultOpen {
  code: SymbolCode;
  layoutId: string;
  cellId: WindowId;
  sender: WindowId | null;
  shown: SymbolCode | null;
  phoneTab: ReturnType<typeof useSelectionStore.getState>["phoneTab"];
}

let pendingOpen: ResultOpen | null = null;
const shownIn = (sender: WindowId | null, cellId: WindowId) => {
  const { layout, groupSymbols } = useLayoutStore.getState();
  return watchedSymbol(layout, sender, cellId, groupSymbols);
};
const toast = (text: string) => useSelectionStore.getState().showToast(text);

export function pendingResultCode(): SymbolCode | null {
  const open = pendingOpen;
  return open && useLayoutStore.getState().layout.id === open.layoutId && useSelectionStore.getState().activeCell === open.cellId
    && shownIn(open.sender, open.cellId) === open.shown && useSelectionStore.getState().phoneTab === open.phoneTab ? open.code : null;
}

export function dropPendingOpen() {
  pendingOpen = null;
}

export async function openResult(queryClient: QueryClient, code: SymbolCode, sender: WindowId | null): Promise<void> {
  const { activeCell: cellId, phoneTab } = useSelectionStore.getState();
  const open: ResultOpen = { code, layoutId: useLayoutStore.getState().layout.id, cellId, sender, shown: shownIn(sender, cellId), phoneTab };
  pendingOpen = open;
  let target: SymbolTarget;
  try {
    target = await queryClient.fetchQuery(symbolInfoQuery(code));
  } catch {
    target = { code };
  }
  if (pendingOpen !== open || pendingResultCode() === null) return;
  pendingOpen = null;
  const { notice } = useLayoutStore.getState().sendSymbol(sender, cellId, target);
  if (notice) toast(notice);
  useSelectionStore.getState().setPhoneTab("chart");
}

export function openResultInCell(queryClient: QueryClient, code: SymbolCode, sender: WindowId | null): Promise<void> {
  const layout = useLayoutStore.getState().layout;
  const senderWindow = sender === null ? undefined : layout.windows.find((w) => w.id === sender);
  return openResult(queryClient, code, senderWindow && senderWindow.link === null ? null : sender);
}

export function sendToWatchlist(listId: string, codes: readonly SymbolCode[]) {
  const store = useWatchlistStore.getState();
  const list = store.lists.find((list) => list.id === listId);
  if (!list) return;
  const added = addSymbols(list.symbols, codes).length - list.symbols.length;
  store.addAll(listId, codes);
  const skipped = codes.length - added;
  if (added === 0) return toast(`${list.name}에 이미 모두 있습니다`);
  toast(`${list.name}에 ${added.toLocaleString("ko-KR")}종목을 넣었습니다${skipped > 0 ? ` (이미 있던 ${skipped.toLocaleString("ko-KR")}종목은 건너뜀)` : ""}`);
}

export function sendToNewWatchlist(name: string, codes: readonly SymbolCode[]) {
  const id = crypto.randomUUID();
  useWatchlistStore.getState().create(id, name);
  useUiStore.getState().setActiveWatchlist(id);
  sendToWatchlist(id, codes);
}

export function addResultToWatchlist(listId: string, code: SymbolCode, name: string) {
  const store = useWatchlistStore.getState();
  const list = store.lists.find((list) => list.id === listId);
  if (!list) return;
  if (list.symbols.includes(code)) return toast(`${list.name}에 이미 있습니다: ${name}`);
  store.addAll(listId, [code]);
  toast(`${list.name}에 넣었습니다: ${name}`);
}
