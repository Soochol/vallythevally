import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Watchlist } from "../../api/generated/Watchlist";
import { nextGroupName } from "../../lib/watchlist";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";

export interface GroupNaming {
  naming: string | null;
  onNaming(id: string | null): void;
}

export function setCollapsed(id: string, collapsed: boolean) {
  const known = useWatchlistStore.getState().lists.flatMap((l) => l.groups.map((g) => g.id));
  useUiStore.getState().setWatchGroupCollapsed(id, collapsed, known);
}

export function startGroup(list: Watchlist, onNaming: GroupNaming["onNaming"], codes?: readonly SymbolCode[]) {
  const id = crypto.randomUUID();
  useWatchlistStore.getState().createGroup(list.id, id, nextGroupName(list), codes);
  onNaming(id);
}
