import { memo, useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Watchlist } from "../../api/generated/Watchlist";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfo } from "../../api/queries";
import { MAX_WATCH_GROUPS, nextGroupName, type Transfer, type WatchColumn, type WatchRowRef, rowKey } from "../../lib/watchlist";
import type { WindowId } from "../../layout/kinds";
import { chartWindow, useLayoutStore, watchedSymbol } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { ArrowIcon, CloseIcon, CopyIcon, ListIcon, MoreIcon, PlusIcon } from "../icons";
import { addRowToCompare, symbolRowMenuItems } from "../list/symbolRowMenu";
import { LIST_ROW_HEIGHT, SymbolName, listRowFill } from "../list/listRow";
import { Menu, type MenuItem } from "../menu/Menu";
import { type GroupNaming, setCollapsed, startGroup } from "./groupActions";
import { QuoteCells, quoteCellIds } from "./QuoteCells";
import { removalUndo } from "./removalUndo";
import type { WatchVariant } from "./columns";
import type { RowPreviewStore } from "./watchKeys";

export interface RowDrag {
  start(row: WatchRowRef): void;
  over(e: React.DragEvent, row: WatchRowRef): void;
  drop(e: React.DragEvent, row: WatchRowRef, index: number): void;
  end(): void;
}

interface RowProps {
  list: Watchlist;
  code: SymbolCode;
  groupId: string | null;
  index: number;
  last: boolean;
  columns: readonly WatchColumn[];
  template: React.CSSProperties;
  variant: WatchVariant;
  sender: WindowId | null;
  preview: RowPreviewStore | null;
  editing: boolean;
  dropBefore: boolean;
  dragging: boolean;
  onMoved(row: WatchRowRef): void;
  onNaming: GroupNaming["onNaming"];
  drag: RowDrag;
}

function useIsActiveRow(sender: WindowId | null, code: SymbolCode, key: string, preview: RowPreviewStore | null): boolean {
  const subscribe = useCallback((listener: () => void) => {
    const stopLayout = useLayoutStore.subscribe(listener);
    const stopSelection = useSelectionStore.subscribe(listener);
    const stopPreview = preview?.subscribe(key, listener);
    return () => {
      stopLayout();
      stopSelection();
      stopPreview?.();
    };
  }, [preview, key]);
  return useSyncExternalStore(subscribe, () => {
    const pending = preview?.get() ?? null;
    if (pending !== null) return pending === key;
    return watchedSymbol(useLayoutStore.getState().layout, sender, useSelectionStore.getState().activeCell) === code;
  });
}

const NO_OTHER_LISTS: readonly Watchlist[] = [];

function WatchRowFrame({ list, code, groupId, index, last, columns, template, variant, sender, preview, editing, dropBefore, dragging, onMoved, onNaming, drag }: RowProps) {
  const row: WatchRowRef = { code, groupId };
  const key = rowKey(row);
  const active = useIsActiveRow(sender, code, key, preview);
  const [menu, setMenu] = useState<{ kind: "actions" | "transfer" | "group" | "addGroup"; x: number; y: number } | null>(null);
  const root = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const infoQuery = useSymbolInfo(code);
  const info = infoQuery.data;
  const unknown = infoQuery.error instanceof ApiRequestError && infoQuery.error.code === "unknown_symbol";
  const name = info?.name ?? code;
  const ids = quoteCellIds(useId(), columns);
  const unknownId = `${ids.name}-unknown`;
  const grouped = list.groups.length > 0;

  const open = () => {
    const cellId = useSelectionStore.getState().activeCell;
    const { notice } = useLayoutStore.getState().sendSymbol(sender, cellId, info ?? { code });
    if (notice) useSelectionStore.getState().showToast(notice);
    if (variant === "phone") useSelectionStore.getState().setPhoneTab("chart");
  };
  const move = (step: -1 | 1) => {
    useWatchlistStore.getState().moveBy(list.id, row, step);
    onMoved(row);
  };
  const remove = (wholeList = false) => {
    const store = useWatchlistStore.getState();
    const undo = removalUndo(wholeList ? store.removeFromListWithUndo(list.id, code) : store.removeRowWithUndo(list.id, row));
    if (undo) useSelectionStore.getState().showToast(`${!wholeList && row.groupId !== null ? list.groups.find((g) => g.id === row.groupId)?.name ?? list.name : list.name}에서 뺐습니다: ${name}`, undo);
  };
  const top = () => { useWatchlistStore.getState().move(list.id, row, 0); onMoved(row); };
  const compare = () => {
    const cellId = useSelectionStore.getState().activeCell;
    addRowToCompare(cellId, chartWindow(useLayoutStore.getState().layout, cellId), code, name);
  };
  const context = (x: number, y: number) => { button.current?.focus(); setMenu({ kind: "actions", x, y }); };
  const actionItems = (others: readonly Watchlist[]): MenuItem[] => {
    const common = symbolRowMenuItems({ name, code, onOpen: open, onCompare: compare });
    return [
      common.heading,
      common.open,
      common.compare,
      { kind: "separator" },
      { kind: "action", label: "맨 위로", icon: <ArrowIcon dir="up" />, hint: "Alt+Home", disabled: index === 0, onSelect: top },
      { kind: "action", label: "그룹에 추가", icon: <PlusIcon />, onSelect: () => { button.current?.focus(); setMenu((current) => current && { ...current, kind: "addGroup" }); } },
      { kind: "action", label: "그룹으로 옮기기", icon: <ListIcon />, onSelect: () => { button.current?.focus(); setMenu((current) => current && { ...current, kind: "group" }); } },
      { kind: "action", label: "다른 목록에 복사", icon: <CopyIcon />, disabled: others.length === 0, onSelect: () => { button.current?.focus(); setMenu((current) => current && { ...current, kind: "transfer" }); } },
      common.copyCode,
      { kind: "separator" },
      ...(row.groupId !== null ? [{ kind: "action", label: "이 그룹에서 빼기", icon: <CloseIcon />, hint: "Del", onSelect: () => remove() } satisfies MenuItem] : []),
      { kind: "action", label: "관심종목에서 빼기", icon: <CloseIcon />, hint: row.groupId === null ? "Del" : undefined, danger: true, onSelect: () => remove(true) },
    ];
  };
  const focusNeighbor = (button: HTMLButtonElement, step: -1 | 1) => {
    const all = Array.from(button.closest("aside, section")?.querySelectorAll<HTMLElement>("[data-main]") ?? []);
    all[all.indexOf(button) + step]?.focus();
  };
  const menuOthers = menu === null ? NO_OTHER_LISTS : useWatchlistStore.getState().lists.filter((l) => l.id !== list.id);

  return (
    <li
      ref={root}
      data-code={code}
      data-row={rowKey(row)}
      draggable={variant === "desktop"}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/plain", rowKey(row));
        drag.start(row);
      }}
      onDragOver={(e) => drag.over(e, row)}
      onDrop={(e) => drag.drop(e, row, index)}
      onDragEnd={drag.end}
      onContextMenu={variant === "desktop" ? (e) => { e.preventDefault(); context(e.clientX, e.clientY); } : undefined}
      className={`group relative ${listRowFill(active)} ${dragging ? "opacity-40" : ""} ${
        dropBefore ? "shadow-[inset_0_2px_0_var(--accent)]" : index > 0 ? "shadow-[inset_0_1px_0_var(--line)]" : ""
      }`}
    >
      <button
        ref={button}
        type="button"
        data-main
        aria-current={active || undefined}
        aria-labelledby={unknown ? `${ids.name} ${unknownId}` : ids.labelledBy}
        aria-keyshortcuts={variant === "desktop" ? "Alt+ArrowUp Alt+ArrowDown Alt+Home Shift+Enter Delete Shift+F10" : "Alt+ArrowUp Alt+ArrowDown"}
        aria-haspopup={variant === "desktop" ? "menu" : undefined}
        aria-expanded={variant === "desktop" ? menu !== null : undefined}
        onClick={editing ? undefined : open}
        onKeyDown={(e) => {
          if (variant === "desktop") {
            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              context(box.x, box.bottom);
              return;
            }
            if (e.key === "Delete") { e.preventDefault(); remove(); return; }
            if (e.shiftKey && e.key === "Enter") { e.preventDefault(); compare(); return; }
            if (e.altKey && e.key === "Home") { e.preventDefault(); top(); return; }
          }
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          const step = e.key === "ArrowUp" ? -1 : 1;
          if (e.altKey) {
            e.preventDefault();
            move(step);
          } else if (variant === "phone") {
            e.preventDefault();
            focusNeighbor(e.currentTarget, step);
          }
        }}
        style={template}
        className={`grid gap-x-2 ${LIST_ROW_HEIGHT} w-full items-center ${grouped ? "pl-5" : "pl-3"} pr-3 text-left outline-none max-md:h-auto max-md:min-h-[56px] max-md:px-4 max-md:py-2 ${
          editing ? (grouped ? "max-md:pr-[220px]" : "max-md:pr-[176px]") : ""
        }`}
      >
        <span className={`flex min-w-0 items-center gap-1 ${unknown ? "opacity-50" : ""}`}>
          <SymbolName id={ids.name} name={name} code={code} />
        </span>
        {unknown ? (
          <span id={unknownId} className={columns.length > 0 ? "text-right text-s text-text-3" : "sr-only"} style={columns.length > 0 ? { gridColumn: `span ${columns.length}` } : undefined}>
            찾을 수 없음
          </span>
        ) : (
          <QuoteCells code={code} columns={columns} ids={ids} />
        )}
      </button>
      {variant === "desktop" ? menu && <Menu key={menu.kind} label={`${name} ${MENU_LABEL[menu.kind]}`} root={root} style={{ left: menu.x, top: menu.y }}
        className="overflow-auto" items={menu.kind === "actions" ? actionItems(menuOthers) : (menu.kind === "group" || menu.kind === "addGroup") ? groupItems(list, row, onNaming, onMoved, menu.kind === "addGroup") : transferItems(list, row, name, menuOthers)} onClose={() => setMenu((current) => current === menu ? null : current)} /> : (
        editing && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
            {grouped && <GroupMoveMenu list={list} row={row} name={name} onNaming={onNaming} onMoved={onMoved} onRemoveFromList={() => remove(true)} />}
            <TransferMenu list={list} row={row} name={name} buttonClass="icon-btn h-10 w-10" />
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 위로`} disabled={index === 0} onClick={() => move(-1)}>
              <ArrowIcon dir="up" />
            </button>
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 아래로`} disabled={last} onClick={() => move(1)}>
              <ArrowIcon dir="down" />
            </button>
            <button type="button" className="icon-btn h-10 w-10 text-danger" aria-label={`${name} 지우기`} onClick={() => remove()}>
              <CloseIcon size={18} />
            </button>
          </div>
        )
      )}
    </li>
  );
}

export const WatchRow = memo(WatchRowFrame);

const MENU_LABEL = { actions: "행 동작", addGroup: "그룹에 추가", group: "그룹으로 옮기기", transfer: "다른 목록으로" } as const;

function groupItems(list: Watchlist, row: WatchRowRef, onNaming: GroupNaming["onNaming"], onMoved: RowProps["onMoved"], additive = false): MenuItem[] {
  const assign = (group: string) => {
    const store = useWatchlistStore.getState();
    store.dropRow(list.id, row, { groupId: group, before: null }, additive ? "copy" : "move-merging");
    setCollapsed(group, false);
    onMoved({ code: row.code, groupId: group });
  };
  return [
    { kind: "heading", label: additive ? "그룹에 추가" : "그룹으로 옮기기" },
    ...list.groups.map((g): MenuItem => (additive ? { kind: "action", label: g.name, disabled: g.symbols.includes(row.code), hint: g.symbols.includes(row.code) ? "이미 있음" : undefined, onSelect: () => assign(g.id) } : { kind: "radio", label: g.name, value: g.id, checked: g.id === row.groupId, onSelect: () => assign(g.id) })),
    ...(!additive && row.groupId !== null ? [{ kind: "action", label: "이 그룹에서 빼기", onSelect: () => {
      const undo = removalUndo(useWatchlistStore.getState().removeRowWithUndo(list.id, row));
      if (undo) useSelectionStore.getState().showToast("그룹에서 뺐습니다", undo);
    } } satisfies MenuItem] : []),
    { kind: "separator" },
    { kind: "action", label: "새 그룹…", icon: <PlusIcon />, disabled: list.groups.length >= MAX_WATCH_GROUPS, onSelect: () => {
      if (additive) return startGroup(list, onNaming, [row.code]);
      const id = crypto.randomUUID();
      useWatchlistStore.getState().moveToNewGroup(list.id, row, id, nextGroupName(list));
      onNaming(id);
    } },
  ];
}

function GroupMoveMenu({ list, row, name, onNaming, onMoved, onRemoveFromList }: { list: Watchlist; row: WatchRowRef; name: string; onNaming: GroupNaming["onNaming"]; onMoved: RowProps["onMoved"]; onRemoveFromList(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  return (
    <div ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-btn h-10 w-10"
        title="그룹으로 옮기기"
        aria-label={`${name} 그룹으로 옮기기`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ListIcon />
      </button>
      {open && <Menu label={`${name} 그룹으로 옮기기`} items={[...groupItems(list, row, onNaming, onMoved), { kind: "separator" }, ...groupItems(list, row, onNaming, onMoved, true).slice(0, -2), { kind: "separator" }, { kind: "action", label: "관심종목에서 빼기", danger: true, onSelect: onRemoveFromList }]} onClose={close} root={root} className="fixed overflow-auto" />}
    </div>
  );
}

function transferItems(list: Watchlist, row: WatchRowRef, name: string, others: readonly Watchlist[]): MenuItem[] {
  const { code } = row;
  const send = (to: Watchlist, how: Transfer) => {
    const { showToast } = useSelectionStore.getState();
    if (to.symbols.includes(code) && how === "copy") return showToast(`${name}은 이미 ${to.name}에 있습니다`);
    useWatchlistStore.getState().transfer(list.id, to.id, row, how);
    showToast(`${how === "move" ? "옮겼습니다" : "복사했습니다"}: ${name} → ${to.name}`);
  };
  return [
    { kind: "heading", label: "다른 목록으로 옮기기" },
    ...others.map((l): MenuItem => ({ kind: "action", label: l.name, onSelect: () => send(l, "move") })),
    { kind: "separator" },
    { kind: "heading", label: "다른 목록에 복사" },
    ...others.map((l): MenuItem => ({ kind: "action", label: l.name, onSelect: () => send(l, "copy") })),
  ];
}

function TransferMenu({ list, row, name, buttonClass }: { list: Watchlist; row: WatchRowRef; name: string; buttonClass: string }) {
  const others = useWatchlistStore((s) => s.lists).filter((l) => l.id !== list.id);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  if (others.length === 0) return null;
  return (
    <div ref={root}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        title="다른 목록으로 옮기거나 복사"
        aria-label={`${name} 다른 목록으로`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon />
      </button>
      {open && <Menu
            label={`${name} 다른 목록으로`}
            items={transferItems(list, row, name, others)}
            onClose={close}
            root={root}
            className="fixed overflow-auto"
          />}
    </div>
  );
}
