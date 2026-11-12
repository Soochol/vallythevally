import type { QueryClient } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { symbolInfoQuery } from "../../api/queries";
import { compareRefusal } from "../../chart/settings";
import type { VenueTarget } from "../../lib/venue";
import { addSymbols } from "../../lib/watchlist";
import { type Slot, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";

interface ResultOpen {
  code: SymbolCode;
  layoutId: string;
  slot: Slot;
  shown: SymbolCode | undefined;
  phoneTab: ReturnType<typeof useSelectionStore.getState>["phoneTab"];
}

let pendingOpen: ResultOpen | null = null;
const shownIn = (slot: Slot) => useLayoutStore.getState().layout.cells.find((cell) => cell.slot === slot)?.symbol;
const toast = (text: string) => useSelectionStore.getState().showToast(text);

export function pendingResultCode(): SymbolCode | null {
  const open = pendingOpen;
  return open && useLayoutStore.getState().layout.id === open.layoutId && useSelectionStore.getState().activeSlot === open.slot
    && shownIn(open.slot) === open.shown && useSelectionStore.getState().phoneTab === open.phoneTab ? open.code : null;
}

export function dropPendingOpen() {
  pendingOpen = null;
}

export async function openResult(queryClient: QueryClient, code: SymbolCode): Promise<void> {
  const { activeSlot: slot, phoneTab } = useSelectionStore.getState();
  const open: ResultOpen = { code, layoutId: useLayoutStore.getState().layout.id, slot, shown: shownIn(slot), phoneTab };
  pendingOpen = open;
  let target: VenueTarget;
  try {
    target = await queryClient.fetchQuery(symbolInfoQuery(code));
  } catch {
    target = { code, nxtEnabled: false };
  }
  if (pendingOpen !== open || pendingResultCode() === null) return;
  pendingOpen = null;
  useLayoutStore.getState().setSymbol(slot, target);
  useSelectionStore.getState().setPhoneTab("chart");
}

export function compareResult(code: SymbolCode, name: string) {
  const { activeSlot: slot } = useSelectionStore.getState();
  const layout = useLayoutStore.getState();
  const cell = layout.layout.cells.find((cell) => cell.slot === slot);
  if (!cell) return;
  const refusal = compareRefusal(cell.chartSettings, code, cell.symbol);
  if (refusal) return toast(refusal === "full" ? "비교 종목은 3개까지입니다" : refusal === "main" ? "현재 종목은 비교에 추가할 수 없습니다" : "이미 비교에 있습니다");
  layout.addCompare(slot, code);
  toast(`비교에 추가했습니다: ${name}`);
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
