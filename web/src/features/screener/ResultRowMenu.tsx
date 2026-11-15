import type { RefObject } from "react";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { PlusIcon } from "../icons";
import { addRowToCompare, symbolRowMenuItems } from "../list/symbolRowMenu";
import { Menu, type MenuItem } from "../menu/Menu";
import { addResultToWatchlist } from "./resultActions";

export interface ResultMenuState {
  code: ScreenerRow["symbol"];
  kind: "actions" | "watchlists";
  x: number;
  y: number;
}

interface Props {
  row: ScreenerRow;
  menu: ResultMenuState;
  root: RefObject<HTMLElement | null>;
  onOpen(): void;
  onWatchlists(): void;
  onClose(): void;
}

export function ResultRowMenu({ row, menu, root, onOpen, onWatchlists, onClose }: Props) {
  const cellId = useSelectionStore((s) => s.activeCell);
  const cell = useCell(cellId);
  const lists = useWatchlistStore((s) => s.lists);
  const common = symbolRowMenuItems({ name: row.name, code: row.symbol, onOpen, onCompare: () => addRowToCompare(cellId, cell, row.symbol, row.name) });
  const items: MenuItem[] = menu.kind === "actions"
    ? [
      common.heading,
      common.open,
      common.compare,
      { kind: "separator" },
      { kind: "action", label: "관심종목에 넣기", icon: <PlusIcon />, onSelect: onWatchlists },
      common.copyCode,
    ]
    : [
      { kind: "heading", label: "관심종목에 넣기" },
      ...lists.map((list): MenuItem => {
        const held = list.symbols.includes(row.symbol);
        return { kind: "action", label: list.name, disabled: held, hint: held ? "이미 있음" : undefined, onSelect: () => addResultToWatchlist(list.id, row.symbol, row.name) };
      }),
    ];
  return <Menu key={menu.kind} label={`${row.name} ${menu.kind === "actions" ? "행 동작" : "관심종목에 넣기"}`} root={root} style={{ left: menu.x, top: menu.y }} className="max-h-[60vh] overflow-auto" items={items} onClose={onClose} />;
}
