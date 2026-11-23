import type { RefObject } from "react";
import type { RankingRow } from "../../api/generated/RankingRow";
import { chartWindow, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { PlusIcon } from "../icons";
import { addRowToCompare, copySymbolCode, symbolRowMenuItems } from "../list/symbolRowMenu";
import { Menu, type MenuItem } from "../menu/Menu";
import { addResultToWatchlist } from "../screener/resultActions";

export interface RankingMenuState {
  code: RankingRow["code"];
  kind: "actions" | "watchlists";
  x: number;
  y: number;
}

interface Props {
  row: RankingRow;
  menu: RankingMenuState;
  root: RefObject<HTMLElement | null>;
  onOpen(): void;
  onWatchlists(): void;
  onClose(): void;
}

function compare(row: RankingRow) {
  const cellId = useSelectionStore.getState().activeCell;
  addRowToCompare(cellId, chartWindow(useLayoutStore.getState().layout, cellId), row.code, row.name);
}

export function RankingRowMenu({ row, menu, root, onOpen, onWatchlists, onClose }: Props) {
  const lists = useWatchlistStore((s) => s.lists);
  const common = symbolRowMenuItems({ name: row.name, code: row.code, onOpen, onCompare: () => compare(row) });
  const items: MenuItem[] = menu.kind === "watchlists"
    ? [
      { kind: "heading", label: "관심종목에 넣기" },
      ...lists.map((list): MenuItem => {
        const held = list.symbols.includes(row.code);
        return { kind: "action", label: list.name, disabled: held, hint: held ? "이미 있음" : undefined, onSelect: () => addResultToWatchlist(list.id, row.code, row.name) };
      }),
    ]
    : row.listed
      ? [common.heading, common.open, common.compare, { kind: "separator" }, { kind: "action", label: "관심종목에 넣기", icon: <PlusIcon />, onSelect: onWatchlists }, common.copyCode]
      : [common.heading, { kind: "action", label: "종목코드 복사", onSelect: () => void copySymbolCode(row.code) }];
  return <Menu key={menu.kind} label={`${row.name} ${menu.kind === "actions" ? "행 동작" : "관심종목에 넣기"}`} root={root} style={{ left: menu.x, top: menu.y }} className="max-h-[60vh] overflow-auto" items={items} onClose={onClose} />;
}
