import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WatchGroup } from "../../api/generated/WatchGroup";
import type { Watchlist } from "../../api/generated/Watchlist";
import { type DropRefusal, groupNameProblem, MAX_WATCHLIST_NAME } from "../../lib/watchlist";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { confirmAction } from "../overlay/Confirm";
import { ArrowIcon, ChevronIcon, CloseIcon, MoreIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { type GroupNaming, setCollapsed } from "./groupActions";

const GROUP_HEAD = "sticky top-0 z-[1] flex h-7 items-center gap-1.5 border-y border-line pl-1 pr-1.5 text-xs font-[600] text-text-2 max-md:h-11 max-md:pl-3";
type HeadDropState = "idle" | "accept" | "refuse";
const HEAD_FILL: Record<HeadDropState, string> = {
  idle: "bg-surface",
  accept: "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]",
  refuse: "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] shadow-[inset_0_0_0_1px_var(--danger)]",
};
export const REFUSAL_NOTE: Partial<Record<DropRefusal, string>> = { "already-in-group": "이미 있음", "in-other-group": "다른 그룹에도 있음" };

export interface HeadDrop {
  state: HeadDropState;
  note: string | null;
  over(e: React.DragEvent): void;
  leave(e: React.DragEvent): void;
  drop(e: React.DragEvent): void;
}

const COUNT_BADGE = "flex-none rounded-s bg-[var(--hover)] px-1.5 text-xs font-[600] leading-4 text-text-2";

function DropNote({ drop }: { drop: HeadDrop }) {
  return drop.note === null ? null : <span className="flex-none text-xs font-[600] text-danger">{drop.note}</span>;
}

export function UngroupedHead({ count, drop }: { count: number; drop: HeadDrop }) {
  return (
    <div className={`${GROUP_HEAD} ${HEAD_FILL[drop.state]} pl-5`} onDragOver={drop.over} onDragLeave={drop.leave} onDrop={drop.drop}>
      <span>그룹 없음</span>
      <span className={COUNT_BADGE}>{count}<span className="sr-only">종목</span></span>
      <span className="flex-1" />
      <DropNote drop={drop} />
    </div>
  );
}

export function GroupHead({ list, group, collapsed, naming, onNaming, drop, panelId }: { list: Watchlist; group: WatchGroup; collapsed: boolean; naming: boolean; onNaming: GroupNaming["onNaming"]; drop: HeadDrop; panelId: string }) {
  if (naming) return <div className={`${GROUP_HEAD} ${HEAD_FILL.idle}`}><GroupNameInput list={list} group={group} onDone={() => onNaming(null)} /></div>;
  return (
    <div className={`group/head ${GROUP_HEAD} ${HEAD_FILL[drop.state]}`} onDragOver={drop.over} onDragLeave={drop.leave} onDrop={drop.drop}>
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1 text-left"
        aria-label={`${group.name} ${group.symbols.length}종목`}
        aria-expanded={!collapsed}
        aria-controls={collapsed || group.symbols.length === 0 ? undefined : panelId}
        onClick={() => setCollapsed(group.id, !collapsed)}
      >
        <span className={`grid flex-none place-items-center text-text transition-transform ${collapsed ? "-rotate-90" : ""}`}><ChevronIcon /></span>
        <span className="truncate">{group.name}</span>
        <span className={COUNT_BADGE}>{group.symbols.length}</span>
      </button>
      <DropNote drop={drop} />
      <button
        type="button"
        className="icon-btn h-6 w-6 flex-none text-accent hover:text-accent opacity-0 group-focus-within/head:opacity-100 group-hover/head:opacity-100 [@media(hover:none)]:opacity-100 max-md:h-10 max-md:w-10 max-md:opacity-100"
        title={`${group.name}에 종목 넣기`}
        aria-label={`${group.name}에 종목 넣기`}
        aria-haspopup="dialog"
        onClick={() => useSelectionStore.getState().openSearch("watch", { listId: list.id, groupId: group.id })}
      >
        <PlusIcon size={14} />
      </button>
      <GroupMenu list={list} group={group} onRename={() => onNaming(group.id)} />
    </div>
  );
}

function GroupMenu({ list, group, onRename }: { list: Watchlist; group: WatchGroup; onRename(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);
  const index = list.groups.findIndex((g) => g.id === group.id);
  const store = useWatchlistStore.getState();
  const forget = () => setCollapsed(group.id, false);
  const remove = async () => {
    const shared = new Set(list.groups.filter((g) => g.id !== group.id).flatMap((g) => g.symbols));
    const count = group.symbols.filter((c) => !shared.has(c)).length;
    if (!await confirmAction(count > 0 ? `${group.name} 그룹과 그 안의 ${count}종목을 지웁니다. 다른 그룹에도 있는 종목은 남습니다` : `${group.name} 그룹을 지웁니다. 다른 그룹에도 있는 종목은 남습니다`, { action: "그룹 지우기", danger: true })) return;
    store.deleteGroup(list.id, group.id);
    forget();
  };
  const items: MenuItem[] = [
    { kind: "action", label: "이름 바꾸기", onSelect: onRename },
    { kind: "action", label: "위로 옮기기", icon: <ArrowIcon dir="up" />, disabled: index <= 0, onSelect: () => store.moveGroupBy(list.id, group.id, -1) },
    { kind: "action", label: "아래로 옮기기", icon: <ArrowIcon dir="down" />, disabled: index === list.groups.length - 1, onSelect: () => store.moveGroupBy(list.id, group.id, 1) },
    { kind: "separator" },
    { kind: "action", label: "그룹 풀기", onSelect: () => { store.ungroup(list.id, group.id); forget(); } },
    { kind: "action", label: "그룹 지우기", danger: true, onSelect: remove },
  ];
  return (
    <div ref={root} className="flex-none">
      <button
        ref={button}
        type="button"
        className="icon-btn h-6 w-6 max-md:h-10 max-md:w-10"
        title="그룹 메뉴"
        aria-label={`${group.name} 그룹 메뉴`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && <Menu label={`${group.name} 그룹 메뉴`} items={items} onClose={close} root={root} className="fixed overflow-auto" />}
    </div>
  );
}

function GroupNameInput({ list, group, onDone }: { list: Watchlist; group: WatchGroup; onDone(): void }) {
  const [value, setValue] = useState(group.name);
  const input = useRef<HTMLInputElement>(null);
  const problem = groupNameProblem(list, value, group.id);
  useEffect(() => input.current?.select(), []);
  const problemId = useId();
  return (
    <form
      className="relative flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem !== null) return;
        useWatchlistStore.getState().renameGroup(list.id, group.id, value.trim());
        onDone();
      }}
    >
      <input
        ref={input}
        autoFocus
        aria-label="그룹 이름"
        aria-invalid={problem !== null}
        aria-describedby={problem ? problemId : undefined}
        maxLength={MAX_WATCHLIST_NAME}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onDone();
        }}
        className="h-6 min-w-0 flex-1 rounded-s border border-line bg-surface px-2 text-s outline-none focus:border-accent aria-invalid:border-danger max-md:h-9"
      />
      <button type="submit" className="tb-btn h-6 text-s max-md:h-9" disabled={problem !== null}>
        바꾸기
      </button>
      <button type="button" className="icon-btn h-6 w-6 max-md:h-9 max-md:w-9" aria-label="취소" onClick={onDone}>
        <CloseIcon />
      </button>
      {problem && (
        <p id={problemId} role="alert" className="absolute left-0 top-[calc(100%+6px)] z-40 rounded-s border border-line bg-surface px-2 py-1 text-s text-danger shadow-dialog">
          {problem}
        </p>
      )}
    </form>
  );
}
