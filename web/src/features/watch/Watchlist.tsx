import { FinancialUpdateButton } from "../financial-update/FinancialUpdateButton";
import { EmptyState } from "../overlay/State";
import { confirmAction } from "../overlay/Confirm";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Watchlist } from "../../api/generated/Watchlist";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import {
  dropRow,
  type DropHow,
  type DropTarget,
  rowKey,
  type WatchRowRef,
  MAX_WATCH_GROUPS,
  MAX_WATCHLIST_NAME,
  MAX_WATCHLISTS,
  nameProblem,
  nextGroupName,
  nextListName,
  WATCH_COLUMN_LABEL,
  WATCH_COLUMNS,
  type WatchColumn,
  type WatchSection,
  watchSections,
} from "../../lib/watchlist";
import type { WindowId } from "../../layout/kinds";
import { quoteBook } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { chooseWatchlist, useWatchlistStore, useWindowWatchlist } from "../../stores/watchlist";
import { ChevronIcon, CloseIcon, CopyIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { Kbd } from "../ui/Kbd";
import { ListHead } from "../list/listRow";
import { columnTemplate, fitColumns, type WatchVariant } from "./columns";
import { GroupHead, type HeadDrop, REFUSAL_NOTE, UngroupedHead } from "./GroupHead";
import { type GroupNaming, setCollapsed, startGroup } from "./groupActions";
import { type RowDrag, WatchRow } from "./WatchRow";
import { useFitted } from "../list/useFitted";
import { useBeforeConnect } from "../status/beforeConnect";

const COPY_KEY_IS_OPTION = /Mac|iPhone|iPad/.test(navigator.platform);
const copyKeyHeld = (e: React.DragEvent) => (COPY_KEY_IS_OPTION ? e.altKey : e.ctrlKey);
const GROUPED_INDENT = 20;
const NO_COLUMNS: readonly WatchColumn[] = [];

const NEW_GROUP_SLOT = "flex h-[34px] w-full items-center gap-1.5 rounded-m px-2.5 text-s text-text-2 hover:bg-[var(--hover)] hover:text-text disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent disabled:hover:text-text-3";
const NEW_GROUP_SLOT_REST = "border border-dashed border-[var(--line-strong)]";
const NEW_GROUP_SLOT_OVER = "border border-[var(--accent)] bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent";
const NEW_GROUP_SLOT_VERB: Record<"move" | "copy", string> = { move: "옮김", copy: "복사" };

const GROUP_SPACING = "[&:not(:first-child)]:mt-1.5";

export function WatchPanel({ id }: { id: WindowId }) {
  const [naming, onNaming] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const chosen = useUiStore((s) => s.prefs.watchColumns);
  const columns = useFitted(root, chosen, fitColumns);
  return (
    <aside ref={root} aria-label="관심종목" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WatchHead window={id} hidden={chosen.filter((c) => !columns.includes(c))} onNaming={onNaming} />
      <WatchList variant="desktop" sender={id} editing={false} naming={naming} onNaming={onNaming} columns={columns} />
    </aside>
  );
}

export function PhoneWatch() {
  const shown = useSelectionStore((s) => s.phoneTab === "watch");
  const [editing, setEditing] = useState(false);
  const chosen = useUiStore((s) => s.prefs.watchColumns);
  const [naming, onNaming] = useState<string | null>(null);
  if (!shown) return null;
  return (
    <section aria-label="관심종목" className="fixed inset-x-0 bottom-[56px] top-0 z-30 flex flex-col bg-bg md:hidden">
      <WatchHead window={null} hidden={NO_COLUMNS} onNaming={onNaming}>
        <FinancialUpdateButton />
        <button type="button" className="tb-btn h-9 text-s" aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? "완료" : "편집"}
        </button>
      </WatchHead>
      <WatchList variant="phone" sender={null} editing={editing} naming={naming} onNaming={onNaming} columns={editing ? NO_COLUMNS : chosen} />
    </section>
  );
}

type Naming = { kind: "create" } | { kind: "rename"; id: string };

function putGroupIn(list: Watchlist): string | null {
  const target = useSelectionStore.getState().putTarget;
  return target?.listId === list.id ? target.groupId : null;
}

function WatchHead({ window, hidden, children, onNaming }: { window: WindowId | null; hidden: readonly WatchColumn[]; children?: React.ReactNode; onNaming: GroupNaming["onNaming"] }) {
  const list = useWindowWatchlist(window);
  const openSearch = useSelectionStore((s) => s.openSearch);
  const [naming, setNaming] = useState<Naming | null>(null);
  const offline = useBeforeConnect() !== null;
  return (
    <div className="flex h-9 flex-none items-center gap-1 border-b border-line pl-1.5 pr-1 max-md:h-12">
      <h2 className="sr-only">관심종목</h2>
      {naming ? (
        <NameInput window={window} naming={naming} onDone={() => setNaming(null)} />
      ) : (
        <>
          <ListMenu window={window} list={list} hidden={hidden} onName={setNaming} onNaming={onNaming} />
          <span className="flex-none text-s text-text-3">{list.symbols.length}종목</span>
          {offline && <span className="min-w-0 shrink-[8] truncate border-l border-line pl-2 text-xs text-text-3">저장된 목록 · 시세 없음</span>}
          <span className="flex-1" />
          <button
            type="button"
            className="inline-flex h-7 flex-none items-center gap-1 rounded-m pl-1.5 pr-[9px] text-s font-[600] text-text shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--hover)] hover:shadow-[inset_0_0_0_1px_var(--accent)] max-md:h-9 max-md:pl-[9px] max-md:pr-3"
            title={`${list.name}에 넣기 (종목 검색)`}
            aria-label="관심종목에 넣기"
            aria-haspopup="dialog"
            onClick={() => openSearch("watch", { listId: list.id, groupId: putGroupIn(list) })}
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

function ListMenu({ window, list, hidden, onName, onNaming }: { window: WindowId | null; list: Watchlist; hidden: readonly WatchColumn[]; onName(n: Naming): void; onNaming: GroupNaming["onNaming"] }) {
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
    if (!await confirmAction(`${list.name} 목록과 그 안의 ${list.symbols.length}종목을 지웁니다. 되돌릴 수 없습니다`, { action: "목록 지우기", danger: true })) return;
    const i = lists.findIndex((l) => l.id === list.id);
    const next = lists[i - 1] ?? lists[i + 1];
    useWatchlistStore.getState().removeList(list.id);
    if (next) chooseWatchlist(window, next.id);
  };
  const ui = useUiStore.getState();
  const items: MenuItem[] = [
    { kind: "heading", label: "목록" },
    ...lists.map((l): MenuItem => ({ kind: "radio", label: l.name, hint: `${l.symbols.length}`, checked: l.id === list.id, onSelect: () => chooseWatchlist(window, l.id) })),
    { kind: "separator" },
    { kind: "action", label: "새 그룹", icon: <PlusIcon />, disabled: list.groups.length >= MAX_WATCH_GROUPS, onSelect: () => startGroup(list, onNaming) },
    { kind: "action", label: "새 목록", icon: <PlusIcon />, disabled: lists.length >= MAX_WATCHLISTS, onSelect: () => onName({ kind: "create" }) },
    { kind: "action", label: "이름 바꾸기", onSelect: () => onName({ kind: "rename", id: list.id }) },
    { kind: "action", label: "복제", icon: <CopyIcon />, disabled: lists.length >= MAX_WATCHLISTS, onSelect: () => {
      const id = crypto.randomUUID();
      useWatchlistStore.getState().duplicate(list.id, id);
      chooseWatchlist(window, id);
    } },
    { kind: "separator" },
    { kind: "heading", label: "열" },
    ...WATCH_COLUMNS.map((c): MenuItem => ({ kind: "check", label: WATCH_COLUMN_LABEL[c], checked: columns.includes(c), hint: hidden.includes(c) ? "창이 좁아 숨김" : undefined, onSelect: () => ui.toggleWatchColumn(c) })),
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
        <span className="truncate text-m font-[600]">{list.name}</span>
        <ChevronIcon />
      </button>
      {open && <Menu label="관심종목 목록" items={items} onClose={close} root={root} className="absolute left-0 top-[calc(100%+4px)] max-h-[70vh] overflow-auto" />}
    </div>
  );
}

function NameInput({ window, naming, onDone }: { window: WindowId | null; naming: Naming; onDone(): void }) {
  const lists = useWatchlistStore((s) => s.lists);
  const self = naming.kind === "rename" ? naming.id : null;
  const [value, setValue] = useState(() => (naming.kind === "rename" ? (lists.find((l) => l.id === naming.id)?.name ?? "") : nextListName(lists)));
  const input = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const problem = nameProblem(lists, value, self);
  useEffect(() => input.current?.select(), []);

  const commit = () => {
    if (problem !== null) return;
    const name = value.trim();
    if (naming.kind === "rename") useWatchlistStore.getState().rename(naming.id, name);
    else {
      const id = crypto.randomUUID();
      useWatchlistStore.getState().create(id, name);
      chooseWatchlist(window, id);
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
        aria-describedby={problem ? problemId : undefined}
        maxLength={MAX_WATCHLIST_NAME}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onDone();
        }}
        className="h-7 min-w-0 flex-1 rounded-s border border-line bg-surface px-2 text-m outline-none focus:border-accent aria-invalid:border-danger max-md:h-10"
      />
      <button type="submit" className="tb-btn h-7 text-s max-md:h-10" disabled={problem !== null}>
        {naming.kind === "create" ? "만들기" : "바꾸기"}
      </button>
      <button type="button" className="icon-btn max-md:h-10 max-md:w-10" aria-label="취소" onClick={onDone}>
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


interface WatchListProps extends GroupNaming {
  variant: WatchVariant;
  sender: WindowId | null;
  editing: boolean;
  columns: readonly WatchColumn[];
}

interface DragState {
  list: Watchlist;
  dragged: WatchRowRef | null;
  hover: { target: DropTarget; how: DropHow } | null;
  hoverOver(e: React.DragEvent, target: DropTarget): void;
  dropOn(e: React.DragEvent, target: DropTarget, sameSectionIndex: number | null): void;
  start(row: WatchRowRef): void;
  end(): void;
}

function WatchList({ variant, sender, editing, naming, onNaming, columns }: WatchListProps) {
  const list = useWindowWatchlist(sender);
  const panelPrefix = useId();
  const symbols = list.symbols;
  const collapsed = useUiStore((s) => s.prefs.collapsedWatchGroups);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const onScreen = variant === "desktop" ? desktop : !desktop;
  const [hover, setHover] = useState<{ target: DropTarget; how: DropHow } | null>(null);
  const [dragged, setDragged] = useState<WatchRowRef | null>(null);
  const [slotHover, setSlotHover] = useState<"move" | "copy" | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const [focusRow, setFocusRow] = useState<WatchRowRef | null>(null);
  const template = useMemo(() => ({ gridTemplateColumns: columnTemplate(variant, columns) }), [variant, columns]);
  const sections = watchSections(list);

  useEffect(() => (onScreen ? quoteBook.lease(symbols) : undefined), [onScreen, symbols]);

  useEffect(() => {
    if (focusRow === null) return;
    scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowKey(focusRow))}"] [data-main]`)?.focus();
    setFocusRow(null);
  }, [focusRow, list]);

  const knownSymbols = useRef({ listId: list.id, symbols });
  useEffect(() => {
    const known = knownSymbols.current;
    knownSymbols.current = { listId: list.id, symbols };
    const box = scroller.current;
    if (!box || known.listId !== list.id) return;
    const added = symbols.filter((code) => !known.symbols.includes(code));
    const line = added.length === 0 ? null : box.querySelector<HTMLElement>(`li[data-code="${CSS.escape(added[added.length - 1]!)}"]`);
    if (!line) return;
    const room = box.getBoundingClientRect();
    const at = line.getBoundingClientRect();
    if (at.bottom > room.bottom) box.scrollTop += at.bottom - room.bottom;
    else if (at.top < room.top) box.scrollTop -= room.top - at.top;
  }, [list.id, symbols]);

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
  const latest = useRef<DragState>(null as unknown as DragState);
  useLayoutEffect(() => {
    latest.current = { list, dragged, hover, hoverOver, dropOn, start: setDragged, end: endDrag };
  });
  const rowDrag = useMemo<RowDrag>(() => ({
    start: (row) => latest.current.start(row),
    over: (e, row) => latest.current.hoverOver(e, { groupId: row.groupId, before: row.code }),
    drop: (e, row, index) => latest.current.dropOn(e, { groupId: row.groupId, before: row.code }, index),
    end: () => latest.current.end(),
  }), []);
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
  const grouped = list.groups.length > 0;
  const rows = (section: WatchSection) => {
    const sectionId = section.group?.id ?? null;
    const sameSection = dragged !== null && dragged.groupId === sectionId;
    return section.symbols.map((code, i) => {
      const here = hover !== null && hover.target.groupId === sectionId && hover.target.before === code;
      const joins = here && sectionId !== null && hoverVerdict !== null && "list" in hoverVerdict;
      return (
        <WatchRow
          key={rowKey({ code, groupId: sectionId })}
          list={list}
          code={code}
          groupId={sectionId}
          index={i}
          last={i === section.symbols.length - 1}
          columns={columns}
          template={template}
          variant={variant}
          sender={sender}
          editing={editing}
          dropBefore={sameSection ? here : joins}
          dragging={dragged !== null && dragged.code === code && dragged.groupId === sectionId}
          onMoved={setFocusRow}
          onNaming={onNaming}
          drag={rowDrag}
        />
      );
    });
  };
  const leave = (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(null);
  const scrollClass = "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden";
  const putSymbols = () => useSelectionStore.getState().openSearch("watch", { listId: list.id, groupId: putGroupIn(list) });

  return (
    <>
      <ListHead template={template} className="max-md:px-4" indent={grouped && variant === "desktop" ? GROUPED_INDENT : undefined} title="끌거나 Alt+↑↓로 순서를 바꿉니다">
        <span>종목</span>
        {columns.map((c) => (
          <span key={c} className="text-right">
            {WATCH_COLUMN_LABEL[c]}
          </span>
        ))}
      </ListHead>
      {symbols.length === 0 && (
        <EmptyState title={`${list.name}에 종목이 없습니다`}>
          <p>
            <Kbd>/</Kbd> 또는 <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>로 종목을 찾을 수 있습니다
          </p>
          <button type="button" className="btn-primary mt-3" onClick={putSymbols}>종목 넣기</button>
        </EmptyState>
      )}
      {!grouped ? (
        <div ref={(el) => { scroller.current = el; }} className={scrollClass} onDragLeave={leave}>
          <ul aria-label={list.name}>{rows(sections[0]!)}</ul>
          {newGroupSlot && <NewGroupSlot {...newGroupSlot} />}
        </div>
      ) : (
        <div ref={(el) => { scroller.current = el; }} role="group" aria-label={list.name} className={scrollClass} onDragLeave={leave}>
          {sections.map(({ group, symbols: codes }, i) => group ? (
            <div key={group.id} className={GROUP_SPACING}>
              <GroupHead list={list} group={group} collapsed={collapsed.includes(group.id)} naming={naming === group.id} onNaming={onNaming} drop={headDrop(group.id)} panelId={`${panelPrefix}-${group.id}`} />
              {!collapsed.includes(group.id) && codes.length > 0 && <ul id={`${panelPrefix}-${group.id}`} aria-label={group.name}>{rows(sections[i]!)}</ul>}
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

