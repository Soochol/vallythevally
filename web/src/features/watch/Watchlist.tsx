import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import { EmptyState } from "../overlay/State";
import { confirmAction } from "../overlay/Confirm";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WatchGroup } from "../../api/generated/WatchGroup";
import type { Watchlist } from "../../api/generated/Watchlist";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfo } from "../../api/queries";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { isIndexCode } from "../../lib/symbol";
import {
  dropRow,
  groupNameProblem,
  type DropHow,
  type DropRefusal,
  type DropTarget,
  rowKey,
  type WatchRowRef,
  MAX_WATCH_GROUPS,
  MAX_WATCHLIST_NAME,
  MAX_WATCHLISTS,
  nameProblem,
  nextGroupName,
  nextListName,
  type Transfer,
  WATCH_COLUMN_LABEL,
  WATCH_COLUMNS,
  type WatchColumn,
  type WatchSection,
  watchSections,
} from "../../lib/watchlist";
import { useCell, useLayoutStore, watchedSymbol } from "../../stores/layout";
import type { WindowId } from "../../layout/kinds";
import type { WatchQuote } from "../../stores/quoteBook";
import { quoteBook } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore, useVenue } from "../../stores/ui";
import { VenueFallbackBadge } from "../venue/VenuePicker";
import { useActiveWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { ArrowIcon, ChevronIcon, CloseIcon, CopyIcon, ListIcon, MoreIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { addRowToCompare, symbolRowMenuItems } from "../list/symbolRowMenu";
import { LIST_HEAD, LIST_ROW_HEIGHT, PriceText, RateBadge, SymbolName, listRowFill } from "../list/listRow";
import { columnTemplate, fitColumns, type WatchVariant } from "./columns";
import { useElementSize } from "../workspace/size";
import { removalUndo } from "./removalUndo";
import { useBeforeConnect } from "../status/beforeConnect";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const ROW_GRID = "grid gap-1";
const GROUP_HEAD = "flex h-[34px] items-center gap-1.5 border-y border-line pl-2 pr-1.5 text-[13px] font-[700] max-md:h-11 max-md:pl-3";
type HeadDropState = "idle" | "accept" | "refuse";
const HEAD_FILL: Record<HeadDropState, string> = {
  idle: "bg-white/[0.045]",
  accept: "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]",
  refuse: "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] shadow-[inset_0_0_0_1px_var(--danger)]",
};
const REFUSAL_NOTE: Partial<Record<DropRefusal, string>> = { "already-in-group": "이미 있음", "in-other-group": "다른 그룹에도 있음" };
const COPY_KEY_IS_OPTION = /Mac|iPhone|iPad/.test(navigator.platform);
const copyKeyHeld = (e: React.DragEvent) => (COPY_KEY_IS_OPTION ? e.altKey : e.ctrlKey);

interface HeadDrop {
  state: HeadDropState;
  note: string | null;
  over(e: React.DragEvent): void;
  leave(e: React.DragEvent): void;
  drop(e: React.DragEvent): void;
}

const NEW_GROUP_SLOT = "flex h-[34px] w-full items-center gap-1.5 rounded-m px-2.5 text-s text-text-2 hover:bg-[var(--hover)] hover:text-text disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent disabled:hover:text-text-3";
const NEW_GROUP_SLOT_REST = "border border-dashed border-[var(--line-strong)]";
const NEW_GROUP_SLOT_OVER = "border border-[var(--accent)] bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent";
const NEW_GROUP_SLOT_VERB: Record<"move" | "copy", string> = { move: "옮김", copy: "복사" };

const GROUP_SPACING = "[&:not(:first-child)]:mt-1.5";
const GROUP_BAR = "h-3.5 w-[3px] flex-none rounded-[2px]";
function setCollapsed(id: string, collapsed: boolean) {
  const known = useWatchlistStore.getState().lists.flatMap((l) => l.groups.map((g) => g.id));
  useUiStore.getState().setWatchGroupCollapsed(id, collapsed, known);
}

const COUNT_BADGE = "flex-none rounded-full bg-white/10 px-1.5 text-xs font-[600] leading-4 text-text";

interface GroupNaming {
  naming: string | null;
  onNaming(id: string | null): void;
}

export function WatchPanel({ id }: { id: WindowId }) {
  const [naming, onNaming] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const width = useElementSize(root)?.w ?? null;
  return (
    <aside ref={root} aria-label="관심종목" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WatchHead onNaming={onNaming} />
      <WatchList variant="desktop" sender={id} editing={false} naming={naming} onNaming={onNaming} width={width} />
    </aside>
  );
}

export function PhoneWatch() {
  const shown = useSelectionStore((s) => s.phoneTab === "watch");
  const [editing, setEditing] = useState(false);
  const [naming, onNaming] = useState<string | null>(null);
  if (!shown) return null;
  return (
    <section aria-label="관심종목" className="fixed inset-x-0 bottom-[56px] top-0 z-30 flex flex-col bg-bg md:hidden">
      <WatchHead onNaming={onNaming}>
        <FinancialUpdateButton />
        <button type="button" className="tb-btn h-9 text-s" aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? "완료" : "편집"}
        </button>
      </WatchHead>
      <WatchList variant="phone" sender={null} editing={editing} naming={naming} onNaming={onNaming} />
    </section>
  );
}

type Naming = { kind: "create" } | { kind: "rename"; id: string };

function startGroup(list: Watchlist, onNaming: GroupNaming["onNaming"], codes?: readonly SymbolCode[]) {
  const id = crypto.randomUUID();
  useWatchlistStore.getState().createGroup(list.id, id, nextGroupName(list), codes);
  onNaming(id);
}

function WatchHead({ children, onNaming }: { children?: React.ReactNode; onNaming: GroupNaming["onNaming"] }) {
  const list = useActiveWatchlist();
  const openSearch = useSelectionStore((s) => s.openSearch);
  const [naming, setNaming] = useState<Naming | null>(null);
  const offline = useBeforeConnect() !== null;
  return (
    <div className="flex h-9 flex-none items-center gap-1 border-b border-line pl-1.5 pr-1 max-md:h-12">
      <h2 className="sr-only">관심종목</h2>
      {naming ? (
        <NameInput naming={naming} onDone={() => setNaming(null)} />
      ) : (
        <>
          <ListMenu list={list} onName={setNaming} onNaming={onNaming} />
          <span className="flex-none text-s text-text-3">{list.symbols.length}종목</span>
          {offline && <span className="min-w-0 shrink-[8] truncate text-xs text-text-3">저장된 목록 · 시세 없음</span>}
          <span className="flex-1" />
          <button
            type="button"
            className="inline-flex h-7 flex-none items-center gap-1 rounded-m pl-1.5 pr-[9px] text-s font-[600] text-text shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--hover)] hover:shadow-[inset_0_0_0_1px_var(--accent)] max-md:h-9 max-md:pl-[9px] max-md:pr-3"
            title={`${list.name}에 넣기 (종목 검색)`}
            aria-label="관심종목에 넣기"
            aria-haspopup="dialog"
            onClick={() => openSearch("watch")}
          >
            <span className="text-accent"><PlusIcon size={14} /></span>
            종목
          </button>
          {children}
        </>
      )}
    </div>
  );
}

function ListMenu({ list, onName, onNaming }: { list: Watchlist; onName(n: Naming): void; onNaming: GroupNaming["onNaming"] }) {
  const lists = useWatchlistStore((s) => s.lists);
  const columns = useUiStore((s) => s.prefs.watchColumns);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);

  const removeActive = async () => {
    if (!await confirmAction(`${list.name} 목록과 그 안의 ${list.symbols.length}종목을 지웁니다`, { action: "목록 지우기", danger: true })) return;
    const i = lists.findIndex((l) => l.id === list.id);
    const next = lists[i - 1] ?? lists[i + 1];
    useWatchlistStore.getState().removeList(list.id);
    if (next) useUiStore.getState().setActiveWatchlist(next.id);
  };
  const ui = useUiStore.getState();
  const items: MenuItem[] = [
    { kind: "heading", label: "목록" },
    ...lists.map((l): MenuItem => ({ kind: "radio", label: l.name, hint: `${l.symbols.length}`, checked: l.id === list.id, onSelect: () => ui.setActiveWatchlist(l.id) })),
    { kind: "separator" },
    { kind: "action", label: "새 그룹", icon: <PlusIcon />, disabled: list.groups.length >= MAX_WATCH_GROUPS, onSelect: () => startGroup(list, onNaming) },
    { kind: "action", label: "새 목록", icon: <PlusIcon />, disabled: lists.length >= MAX_WATCHLISTS, onSelect: () => onName({ kind: "create" }) },
    { kind: "action", label: "이름 바꾸기", onSelect: () => onName({ kind: "rename", id: list.id }) },
    { kind: "action", label: "복제", icon: <CopyIcon />, disabled: lists.length >= MAX_WATCHLISTS, onSelect: () => {
      const id = crypto.randomUUID();
      useWatchlistStore.getState().duplicate(list.id, id);
      ui.setActiveWatchlist(id);
    } },
    { kind: "separator" },
    { kind: "heading", label: "열" },
    ...WATCH_COLUMNS.map((c): MenuItem => ({ kind: "check", label: WATCH_COLUMN_LABEL[c], checked: columns.includes(c), onSelect: () => ui.toggleWatchColumn(c) })),
    { kind: "separator" },
    { kind: "action", label: "목록 지우기", danger: true, disabled: lists.length <= 1, onSelect: removeActive },
  ];
  return (
    <div ref={root} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        className="tb-btn h-7 min-w-0 max-w-full gap-1 px-1.5 max-md:h-10"
        title="관심종목 목록과 열"
        aria-label={`관심종목 목록: ${list.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate text-m font-[650]">{list.name}</span>
        <ChevronIcon />
      </button>
      {open && <Menu label="관심종목 목록" items={items} onClose={close} root={root} className="absolute left-0 top-[calc(100%+4px)] max-h-[70vh] overflow-auto" />}
    </div>
  );
}

function NameInput({ naming, onDone }: { naming: Naming; onDone(): void }) {
  const lists = useWatchlistStore((s) => s.lists);
  const self = naming.kind === "rename" ? naming.id : null;
  const [value, setValue] = useState(() => (naming.kind === "rename" ? (lists.find((l) => l.id === naming.id)?.name ?? "") : nextListName(lists)));
  const input = useRef<HTMLInputElement>(null);
  const problem = nameProblem(lists, value, self);
  useEffect(() => input.current?.select(), []);

  const commit = () => {
    if (problem !== null) return;
    const name = value.trim();
    if (naming.kind === "rename") useWatchlistStore.getState().rename(naming.id, name);
    else {
      const id = crypto.randomUUID();
      useWatchlistStore.getState().create(id, name);
      useUiStore.getState().setActiveWatchlist(id);
    }
    onDone();
  };
  return (
    <form
      className="relative flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <input
        ref={input}
        aria-label={naming.kind === "create" ? "새 목록 이름" : "목록 이름"}
        aria-invalid={problem !== null}
        aria-describedby={problem ? "watch-name-problem" : undefined}
        maxLength={MAX_WATCHLIST_NAME}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onDone();
        }}
        className="h-7 min-w-0 flex-1 rounded-s border border-line bg-surface px-2 text-m outline-none focus:border-accent aria-invalid:border-up max-md:h-10"
      />
      <button type="submit" className="tb-btn h-7 text-s max-md:h-10" disabled={problem !== null}>
        {naming.kind === "create" ? "만들기" : "바꾸기"}
      </button>
      <button type="button" className="icon-btn max-md:h-10 max-md:w-10" aria-label="취소" onClick={onDone}>
        <CloseIcon />
      </button>
      {problem && (
        <p id="watch-name-problem" role="alert" className="absolute left-0 top-[calc(100%+6px)] z-40 rounded-s border border-line bg-surface px-2 py-1 text-s text-danger shadow-dialog">
          {problem}
        </p>
      )}
    </form>
  );
}

function WatchList({ variant, sender, editing, naming, onNaming, width = null }: { variant: WatchVariant; sender: WindowId | null; editing: boolean; width?: number | null } & GroupNaming) {
  const list = useActiveWatchlist();
  const symbols = list.symbols;
  const chosen = useUiStore((s) => s.prefs.watchColumns);
  const collapsed = useUiStore((s) => s.prefs.collapsedWatchGroups);
  const columns = editing ? [] : width === null ? chosen : fitColumns(chosen, width);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const onScreen = variant === "desktop" ? desktop : !desktop;
  const [hover, setHover] = useState<{ target: DropTarget; how: DropHow } | null>(null);
  const [dragged, setDragged] = useState<WatchRowRef | null>(null);
  const [slotHover, setSlotHover] = useState<"move" | "copy" | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const [focusRow, setFocusRow] = useState<WatchRowRef | null>(null);
  const template = { gridTemplateColumns: columnTemplate(variant, columns) };
  const sections = watchSections(list);

  useEffect(() => (onScreen ? quoteBook.lease(symbols) : undefined), [onScreen, symbols]);

  useEffect(() => {
    if (focusRow === null) return;
    scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowKey(focusRow))}"] [data-main]`)?.focus();
    setFocusRow(null);
  }, [focusRow, list]);

  const endDrag = () => {
    setDragged(null);
    setHover(null);
    setSlotHover(null);
  };
  const howFor = (e: React.DragEvent, target: DropTarget): "move" | "copy" => (dragged?.groupId != null && target.groupId !== null && dragged.groupId !== target.groupId && copyKeyHeld(e) ? "copy" : "move");
  const hoverOver = (e: React.DragEvent, target: DropTarget) => {
    if (dragged === null) return;
    setSlotHover(null);
    const how = howFor(e, target);
    const refused = dragged.groupId !== target.groupId && "refusal" in dropRow(list, dragged, target, how);
    if (refused) e.dataTransfer.dropEffect = "none";
    else if (dragged.groupId !== target.groupId || target.before !== null) {
      e.preventDefault();
      e.dataTransfer.dropEffect = how;
    } else {
      setHover(null);
      return;
    }
    setHover((now) => (now !== null && now.how === how && now.target.groupId === target.groupId && now.target.before === target.before ? now : { target, how }));
  };
  const dropOn = (e: React.DragEvent, target: DropTarget, sameSectionIndex: number | null) => {
    e.preventDefault();
    const store = useWatchlistStore.getState();
    if (dragged !== null && dragged.groupId === target.groupId) {
      if (sameSectionIndex !== null) store.move(list.id, dragged, sameSectionIndex);
    } else if (dragged !== null) {
      const how = howFor(e, target);
      if ("list" in dropRow(list, dragged, target, how)) {
        store.dropRow(list.id, dragged, target, how);
        if (target.groupId !== null) setCollapsed(target.groupId, false);
        setFocusRow({ code: dragged.code, groupId: target.groupId });
      }
    }
    endDrag();
  };
  const slotFull = list.groups.length >= MAX_WATCH_GROUPS;
  const slotHowFor = (e: React.DragEvent): "move" | "copy" => (dragged?.groupId != null && copyKeyHeld(e) ? "copy" : "move");
  const newGroupSlot: NewGroupSlotProps | null = symbols.length === 0 ? null : {
    full: slotFull,
    desktop: variant === "desktop",
    over: slotFull || dragged === null ? null : slotHover,
    create: () => startGroup(list, onNaming),
    dragOver: (e) => {
      if (dragged === null) return;
      setHover(null);
      if (slotFull) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      const how = slotHowFor(e);
      e.dataTransfer.dropEffect = how;
      setSlotHover(how);
    },
    dragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSlotHover(null);
    },
    drop: (e) => {
      e.preventDefault();
      if (dragged !== null && !slotFull) {
        if (slotHowFor(e) === "copy") startGroup(list, onNaming, [dragged.code]);
        else {
          const id = crypto.randomUUID();
          useWatchlistStore.getState().moveToNewGroup(list.id, dragged, id, nextGroupName(list));
          onNaming(id);
        }
      }
      endDrag();
    },
  };
  const hoverVerdict = hover === null || dragged === null ? null : dropRow(list, dragged, hover.target, hover.how);
  const headDrop = (groupId: string | null): HeadDrop => {
    const mine = hover !== null && hover.target.groupId === groupId && hoverVerdict !== null && dragged?.groupId !== groupId ? hover : null;
    const refusal = mine !== null && hoverVerdict !== null && "refusal" in hoverVerdict ? hoverVerdict.refusal : null;
    const accepts = mine !== null && refusal === null && (mine.target.before === null || groupId === null);
    return {
      state: refusal !== null ? "refuse" : accepts ? "accept" : "idle",
      note: refusal === null ? null : REFUSAL_NOTE[refusal] ?? null,
      over: (e) => hoverOver(e, { groupId, before: null }),
      leave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover((now) => (now !== null && now.target.groupId === groupId ? null : now));
      },
      drop: (e) => dropOn(e, { groupId, before: null }, null),
    };
  };
  const rows = (section: WatchSection) => {
    const sectionId = section.group?.id ?? null;
    const sameSection = dragged !== null && dragged.groupId === sectionId;
    return section.symbols.map((code, i) => {
      const target: DropTarget = { groupId: sectionId, before: code };
      const here = hover !== null && hover.target.groupId === sectionId && hover.target.before === code;
      const joins = here && sectionId !== null && hoverVerdict !== null && "list" in hoverVerdict;
      return (
        <WatchRow
          key={rowKey({ code, groupId: sectionId })}
          list={list}
          row={{ code, groupId: sectionId }}
          index={i}
          last={i === section.symbols.length - 1}
          columns={columns}
          template={template}
          variant={variant}
          sender={sender}
          editing={editing}
          dropBefore={sameSection ? here : joins}
          onMoved={setFocusRow}
          onNaming={onNaming}
          drag={{
            start: () => setDragged({ code, groupId: sectionId }),
            over: (e) => hoverOver(e, target),
            drop: (e) => dropOn(e, target, i),
            end: endDrag,
          }}
        />
      );
    });
  };
  const leave = (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(null);
  const scrollClass = "min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

  return (
    <>
      <div className={`${ROW_GRID} flex-none px-3 py-1 ${LIST_HEAD}`} style={template} aria-hidden="true" title="끌거나 Alt+↑↓로 순서를 바꿉니다">
        <span>종목</span>
        {columns.map((c) => (
          <span key={c} className="text-right">
            {WATCH_COLUMN_LABEL[c]}
          </span>
        ))}
      </div>
      {symbols.length === 0 && <EmptyState title={`${list.name}에 종목이 없습니다`} action="종목 넣기" onAction={() => useSelectionStore.getState().openSearch("watch")} />}
      {list.groups.length === 0 ? (
        <div ref={(el) => { scroller.current = el; }} className={scrollClass} onDragLeave={leave}>
          <ul aria-label={list.name}>{rows(sections[0]!)}</ul>
          {newGroupSlot && <NewGroupSlot {...newGroupSlot} />}
        </div>
      ) : (
        <div ref={(el) => { scroller.current = el; }} role="group" aria-label={list.name} className={scrollClass} onDragLeave={leave}>
          {sections.map(({ group, symbols: codes }, i) => group ? (
            <div key={group.id} className={GROUP_SPACING}>
              <GroupHead list={list} group={group} collapsed={collapsed.includes(group.id)} naming={naming === group.id} onNaming={onNaming} drop={headDrop(group.id)} />
              {!collapsed.includes(group.id) && codes.length > 0 && <ul id={`watch-group-${group.id}`} aria-label={group.name}>{rows(sections[i]!)}</ul>}
            </div>
          ) : codes.length > 0 && (
            <div key="ungrouped" className={GROUP_SPACING}>
              <UngroupedHead count={codes.length} drop={headDrop(null)} />
              <ul aria-label="그룹 없음">{rows(sections[i]!)}</ul>
            </div>
          ))}
          {newGroupSlot && <NewGroupSlot {...newGroupSlot} />}
        </div>
      )}
    </>
  );
}

interface NewGroupSlotProps {
  full: boolean;
  desktop: boolean;
  over: "move" | "copy" | null;
  create(): void;
  dragOver(e: React.DragEvent): void;
  dragLeave(e: React.DragEvent): void;
  drop(e: React.DragEvent): void;
}

function NewGroupSlot({ full, desktop, over, create, dragOver, dragLeave, drop }: NewGroupSlotProps) {
  const limit = `그룹은 ${MAX_WATCH_GROUPS}개까지입니다`;
  return (
    <div className="px-2.5 pb-3 pt-2.5" onDragOver={desktop ? dragOver : undefined} onDragLeave={desktop ? dragLeave : undefined} onDrop={desktop ? drop : undefined}>
      <button
        type="button"
        className={`${NEW_GROUP_SLOT} ${over === null ? NEW_GROUP_SLOT_REST : NEW_GROUP_SLOT_OVER}`}
        aria-label="새 그룹"
        title={full ? limit : undefined}
        disabled={full}
        onClick={create}
      >
        <PlusIcon size={14} />
        <span className="min-w-0 truncate">{full ? limit : over === null ? "새 그룹" : `여기 놓으면 새 그룹으로 ${NEW_GROUP_SLOT_VERB[over]}`}</span>
        {desktop && !full && over === null && <span className="ml-auto flex-none text-xs text-text-3">종목을 끌어 놓아도 됩니다</span>}
      </button>
    </div>
  );
}

function DropNote({ drop }: { drop: HeadDrop }) {
  return drop.note === null ? null : <span className="flex-none text-xs font-[600] text-danger">{drop.note}</span>;
}

function UngroupedHead({ count, drop }: { count: number; drop: HeadDrop }) {
  return (
    <div className={`${GROUP_HEAD} ${HEAD_FILL[drop.state]} pl-[26px] text-text-2`} onDragOver={drop.over} onDragLeave={drop.leave} onDrop={drop.drop}>
      <span aria-hidden="true" className={`${GROUP_BAR} bg-text-3`} />
      <span>그룹 없음</span>
      <span className={COUNT_BADGE}>{count}<span className="sr-only">종목</span></span>
      <span className="flex-1" />
      <DropNote drop={drop} />
    </div>
  );
}

function GroupHead({ list, group, collapsed, naming, onNaming, drop }: { list: Watchlist; group: WatchGroup; collapsed: boolean; naming: boolean; onNaming: GroupNaming["onNaming"]; drop: HeadDrop }) {
  if (naming) return <div className={`${GROUP_HEAD} ${HEAD_FILL.idle} text-text`}><GroupNameInput list={list} group={group} onDone={() => onNaming(null)} /></div>;
  return (
    <div className={`${GROUP_HEAD} ${HEAD_FILL[drop.state]} text-text`} onDragOver={drop.over} onDragLeave={drop.leave} onDrop={drop.drop}>
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-label={`${group.name} ${group.symbols.length}종목`}
        aria-expanded={!collapsed}
        aria-controls={collapsed || group.symbols.length === 0 ? undefined : `watch-group-${group.id}`}
        onClick={() => setCollapsed(group.id, !collapsed)}
      >
        <span className={`grid flex-none place-items-center text-text transition-transform ${collapsed ? "-rotate-90" : ""}`}><ChevronIcon /></span>
        <span aria-hidden="true" className={`${GROUP_BAR} bg-accent`} />
        <span className="truncate">{group.name}</span>
        <span className={COUNT_BADGE}>{group.symbols.length}</span>
      </button>
      <DropNote drop={drop} />
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
        className="icon-btn h-[22px] w-[22px] max-md:h-10 max-md:w-10"
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
  const problemId = `watch-group-name-problem-${group.id}`;
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
        className="h-6 min-w-0 flex-1 rounded-s border border-line bg-surface px-2 text-s outline-none focus:border-accent aria-invalid:border-up max-md:h-9"
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

interface RowProps {
  list: Watchlist;
  row: WatchRowRef;
  index: number;
  last: boolean;
  columns: readonly WatchColumn[];
  template: React.CSSProperties;
  variant: WatchVariant;
  sender: WindowId | null;
  editing: boolean;
  dropBefore: boolean;
  onMoved(row: WatchRowRef): void;
  onNaming: GroupNaming["onNaming"];
  drag: { start(): void; over(e: React.DragEvent): void; drop(e: React.DragEvent): void; end(): void };
}

function cellText(column: WatchColumn, quote: Quote, isIndex: boolean): string {
  switch (column) {
    case "price":
      return formatPrice(quote.price, isIndex);
    case "change":
      return formatChange(quote.change, isIndex);
    case "changeRate":
      return formatPercent(quote.changeRate);
    case "volume":
      return formatVolume(quote.volume);
  }
}

const SIGNED: ReadonlySet<WatchColumn> = new Set(["change", "changeRate"]);

function useWatchQuote(code: SymbolCode): WatchQuote {
  const subscribe = useCallback((listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  return useSyncExternalStore(subscribe, () => quoteBook.get(code));
}

function QuoteCell({ column, quote, limited, isIndex, variant }: { column: WatchColumn; quote: Quote | undefined; limited: boolean; isIndex: boolean; variant: WatchVariant }) {
  if (column === "price" && limited)
    return (
      <span className="text-right text-text-3" title="실시간 아님">
        {quote && <span className={variant === "desktop" ? "text-xs" : "block"}>{cellText(column, quote, isIndex)}</span>}
        {variant === "desktop" ? <small className="ml-1 text-warning">·<span className="sr-only">실시간 아님</span></small> : <small className="whitespace-nowrap text-xs">실시간 아님</small>}
      </span>
    );
  if (!quote) return <span className="text-right text-text-3">—</span>;
  const text = cellText(column, quote, isIndex);
  if (column === "changeRate" && variant === "desktop") return <RateBadge direction={direction(quote.change)}>{text}</RateBadge>;
  if (column === "price") return <PriceText>{text}</PriceText>;
  return <span className={`whitespace-nowrap text-right ${SIGNED.has(column) ? `text-s font-[550] ${DIR_CLASS[direction(quote.change)]}` : ""}`}>{text}</span>;
}

function WatchRow({ list, row, index, last, columns, template, variant, sender, editing, dropBefore, onMoved, onNaming, drag }: RowProps) {
  const { code } = row;
  const cellId = useSelectionStore((s) => s.activeCell);
  const cell = useCell(cellId);
  const active = useLayoutStore((s) => watchedSymbol(s.layout, sender, cellId)) === code;
  const others = useWatchlistStore((s) => s.lists).filter((l) => l.id !== list.id);
  const [menu, setMenu] = useState<{ kind: "actions" | "transfer" | "group" | "addGroup"; x: number; y: number } | null>(null);
  const root = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const infoQuery = useSymbolInfo(code);
  const info = infoQuery.data;
  const unknown = infoQuery.error instanceof ApiRequestError && infoQuery.error.code === "unknown_symbol";
  const isIndex = isIndexCode(code);
  const name = info?.name ?? code;
  const { quote, limited } = useWatchQuote(code);
  const appVenue = useVenue();
  const fallsBackToCombined = quote?.venue != null && quote.venue !== appVenue;
  const { moveBy } = useWatchlistStore.getState();
  const values = quote ? columns.map((c) => cellText(c, quote, isIndex)).join(" ") : "";
  const label = unknown ? [name, "찾을 수 없음"] : [name, fallsBackToCombined ? "통합 시세" : "", values, limited ? "실시간 아님" : ""];

  const open = () => {
    const { notice } = useLayoutStore.getState().sendSymbol(sender, cellId, info ?? { code });
    if (notice) useSelectionStore.getState().showToast(notice);
    if (variant === "phone") useSelectionStore.getState().setPhoneTab("chart");
  };
  const move = (step: -1 | 1) => {
    moveBy(list.id, row, step);
    onMoved(row);
  };
  const remove = (wholeList = false) => {
    const store = useWatchlistStore.getState();
    const undo = removalUndo(wholeList ? store.removeFromListWithUndo(list.id, code) : store.removeRowWithUndo(list.id, row));
    if (undo) useSelectionStore.getState().showToast(`${!wholeList && row.groupId !== null ? list.groups.find((g) => g.id === row.groupId)?.name ?? list.name : list.name}에서 뺐습니다: ${name}`, undo);
  };
  const top = () => { useWatchlistStore.getState().move(list.id, row, 0); onMoved(row); };
  const compare = () => addRowToCompare(cellId, cell, code, name);
  const context = (x: number, y: number) => { button.current?.focus(); setMenu({ kind: "actions", x, y }); };
  const common = symbolRowMenuItems({ name, code, onOpen: open, onCompare: compare });
  const items: MenuItem[] = [
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

  return (
    <li
      ref={root}
      data-code={code}
      data-row={rowKey(row)}
      draggable={variant === "desktop"}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copyMove";
        e.dataTransfer.setData("text/plain", rowKey(row));
        drag.start();
      }}
      onDragOver={drag.over}
      onDrop={drag.drop}
      onDragEnd={drag.end}
      onContextMenu={variant === "desktop" ? (e) => { e.preventDefault(); context(e.clientX, e.clientY); } : undefined}
      className={`group relative ${listRowFill(active)} ${
        dropBefore ? "shadow-[inset_0_2px_0_var(--accent)]" : ""
      }`}
    >
      <button
        ref={button}
        type="button"
        data-main
        aria-current={active || undefined}
        aria-label={label.filter((part) => part !== "").join(" ")}
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
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          move(e.key === "ArrowUp" ? -1 : 1);
        }}
        style={template}
        className={`${ROW_GRID} ${LIST_ROW_HEIGHT} w-full items-center ${list.groups.length > 0 ? "pl-[35px]" : "pl-3"} pr-3 text-left max-md:h-auto max-md:min-h-[56px] max-md:px-4 max-md:py-2 ${
          editing ? (list.groups.length > 0 ? "max-md:pr-[220px]" : "max-md:pr-[176px]") : ""
        }`}
      >
        <span className={`flex min-w-0 items-center gap-1 ${unknown ? "opacity-50" : ""}`}>
          <SymbolName name={name} code={code} />
          {fallsBackToCombined && <VenueFallbackBadge />}
        </span>
        {unknown ? (
          columns.length > 0 && (
            <span className="text-right text-s text-text-3" style={{ gridColumn: `span ${columns.length}` }}>
              찾을 수 없음
            </span>
          )
        ) : (
          columns.map((c) => <QuoteCell key={c} column={c} quote={quote} limited={limited} isIndex={isIndex} variant={variant} />)
        )}
      </button>
      {variant === "desktop" ? menu && <Menu key={menu.kind} label={`${name} ${MENU_LABEL[menu.kind]}`} root={root} style={{ left: menu.x, top: menu.y }}
        className="overflow-auto" items={menu.kind === "actions" ? items : (menu.kind === "group" || menu.kind === "addGroup") ? groupItems(list, row, onNaming, onMoved, menu.kind === "addGroup") : transferItems(list, row, name, others)} onClose={() => setMenu((current) => current === menu ? null : current)} /> : (
        editing && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
            {list.groups.length > 0 && <GroupMoveMenu list={list} row={row} name={name} onNaming={onNaming} onMoved={onMoved} onRemoveFromList={() => remove(true)} />}
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
