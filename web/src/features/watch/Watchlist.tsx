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
import { compareRefusal } from "../../chart/settings";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { isIndexCode, symbolSub } from "../../lib/symbol";
import {
  groupNameProblem,
  groupOf,
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
import { useCell, useLayoutStore } from "../../stores/layout";
import type { WatchQuote } from "../../stores/quoteBook";
import { quoteBook } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useActiveWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { ArrowIcon, ChartIcon, ChevronIcon, CloseIcon, CopyIcon, ListIcon, MoreIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { columnTemplate, type WatchVariant } from "./columns";
import { removeWithUndo } from "./removalUndo";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const ROW_GRID = "grid gap-1";
const BADGE_CLASS = { up: "bg-up/10 text-up", down: "bg-down/10 text-down", flat: "bg-raised text-text-2" } as const;
const GROUP_HEAD = "flex h-[30px] items-center gap-1.5 border-t border-line pl-2 pr-1.5 text-s max-md:h-11 max-md:pl-3";
function setCollapsed(id: string, collapsed: boolean) {
  const known = useWatchlistStore.getState().lists.flatMap((l) => l.groups.map((g) => g.id));
  useUiStore.getState().setWatchGroupCollapsed(id, collapsed, known);
}

const COUNT_BADGE = "flex-none rounded-full bg-raised px-1.5 text-xs leading-4 text-text-2";

interface GroupNaming {
  naming: string | null;
  onNaming(id: string | null): void;
}

export function WatchPanel() {
  const [naming, onNaming] = useState<string | null>(null);
  return (
    <aside aria-label="관심종목" className="flex min-h-0 flex-1 flex-col">
      <WatchHead onNaming={onNaming} />
      <WatchList variant="desktop" editing={false} naming={naming} onNaming={onNaming} />
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
      <WatchList variant="phone" editing={editing} naming={naming} onNaming={onNaming} />
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
  return (
    <div className="flex h-9 flex-none items-center gap-1 border-b border-line pl-1.5 pr-1 max-md:h-12">
      <h2 className="sr-only">관심종목</h2>
      {naming ? (
        <NameInput naming={naming} onDone={() => setNaming(null)} />
      ) : (
        <>
          <ListMenu list={list} onName={setNaming} />
          <span className="flex-none text-s text-text-3">{list.symbols.length}종목</span>
          <span className="flex-1" />
          <button
            type="button"
            className="tb-btn h-7 flex-none gap-1 px-1.5 text-s max-md:h-10"
            title={list.groups.length >= MAX_WATCH_GROUPS ? `그룹은 ${MAX_WATCH_GROUPS}개까지입니다` : "새 그룹"}
            aria-label="새 그룹"
            disabled={list.groups.length >= MAX_WATCH_GROUPS}
            onClick={() => startGroup(list, onNaming)}
          >
            <PlusIcon size={12} />
            그룹
          </button>
          <button
            type="button"
            className="icon-btn max-md:h-10 max-md:w-10"
            title={`${list.name}에 넣기`}
            aria-label="관심종목에 넣기"
            aria-haspopup="dialog"
            onClick={() => openSearch("watch")}
          >
            <PlusIcon />
          </button>
          {children}
        </>
      )}
    </div>
  );
}

function ListMenu({ list, onName }: { list: Watchlist; onName(n: Naming): void }) {
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

function WatchList({ variant, editing, naming, onNaming }: { variant: WatchVariant; editing: boolean } & GroupNaming) {
  const list = useActiveWatchlist();
  const symbols = list.symbols;
  const chosen = useUiStore((s) => s.prefs.watchColumns);
  const collapsed = useUiStore((s) => s.prefs.collapsedWatchGroups);
  const columns = editing ? [] : chosen;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const onScreen = variant === "desktop" ? desktop : !desktop;
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dragged, setDragged] = useState<SymbolCode | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const [focusCode, setFocusCode] = useState<SymbolCode | null>(null);
  const template = { gridTemplateColumns: columnTemplate(variant, columns) };
  const sections = watchSections(list);

  useEffect(() => (onScreen ? quoteBook.lease(symbols) : undefined), [onScreen, symbols]);

  useEffect(() => {
    if (focusCode === null) return;
    scroller.current?.querySelector<HTMLElement>(`[data-code="${CSS.escape(focusCode)}"] [data-main]`)?.focus();
    setFocusCode(null);
  }, [focusCode, list]);

  const endDrag = () => {
    setDragged(null);
    setDragOver(null);
  };
  const rows = (section: WatchSection) => {
    const sameSection = dragged !== null && (groupOf(list, dragged)?.id ?? null) === (section.group?.id ?? null);
    return section.symbols.map((code, i) => (
      <WatchRow
        key={code}
        list={list}
        code={code}
        index={i}
        last={i === section.symbols.length - 1}
        columns={columns}
        template={template}
        variant={variant}
        editing={editing}
        dropBefore={sameSection && dragOver === i}
        onMoved={setFocusCode}
        onNaming={onNaming}
        drag={{
          start: () => setDragged(code),
          over: () => sameSection && setDragOver(i),
          drop: () => {
            if (sameSection) useWatchlistStore.getState().move(list.id, dragged, i);
            endDrag();
          },
          end: endDrag,
        }}
      />
    ));
  };
  const leave = (e: React.DragEvent) => e.currentTarget === e.target && setDragOver(null);
  const scrollClass = "min-h-0 flex-1 overflow-y-auto overflow-x-hidden";

  return (
    <>
      <div className={`${ROW_GRID} flex-none px-3 py-1 text-xs text-text-3`} style={template} aria-hidden="true" title="끌거나 Alt+↑↓로 순서를 바꿉니다">
        <span>종목</span>
        {columns.map((c) => (
          <span key={c} className="text-right">
            {WATCH_COLUMN_LABEL[c]}
          </span>
        ))}
      </div>
      {symbols.length === 0 && <EmptyState title={`${list.name}에 종목이 없습니다. +로 종목을 넣으세요`} action="종목 넣기" onAction={() => useSelectionStore.getState().openSearch("watch")} />}
      {list.groups.length === 0 ? (
        <ul ref={(el) => { scroller.current = el; }} aria-label={list.name} className={scrollClass} onDragLeave={leave}>
          {rows(sections[0]!)}
        </ul>
      ) : (
        <div ref={(el) => { scroller.current = el; }} role="group" aria-label={list.name} className={scrollClass} onDragLeave={leave}>
          {sections.map(({ group, symbols: codes }, i) => group ? (
            <div key={group.id}>
              <GroupHead list={list} group={group} collapsed={collapsed.includes(group.id)} naming={naming === group.id} onNaming={onNaming} />
              {!collapsed.includes(group.id) && codes.length > 0 && <ul id={`watch-group-${group.id}`} aria-label={group.name}>{rows(sections[i]!)}</ul>}
            </div>
          ) : codes.length > 0 && (
            <div key="ungrouped">
              <div className={`${GROUP_HEAD} text-text-2`}>
                <span className="font-[600]">그룹 없음</span>
                <span className={COUNT_BADGE}>{codes.length}<span className="sr-only">종목</span></span>
              </div>
              <ul aria-label="그룹 없음">{rows(sections[i]!)}</ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GroupHead({ list, group, collapsed, naming, onNaming }: { list: Watchlist; group: WatchGroup; collapsed: boolean; naming: boolean; onNaming: GroupNaming["onNaming"] }) {
  if (naming) return <div className={GROUP_HEAD}><GroupNameInput list={list} group={group} onDone={() => onNaming(null)} /></div>;
  return (
    <div className={GROUP_HEAD}>
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-label={`${group.name} ${group.symbols.length}종목`}
        aria-expanded={!collapsed}
        aria-controls={collapsed || group.symbols.length === 0 ? undefined : `watch-group-${group.id}`}
        onClick={() => setCollapsed(group.id, !collapsed)}
      >
        <span className={`grid flex-none place-items-center text-text-2 transition-transform ${collapsed ? "-rotate-90" : ""}`}><ChevronIcon /></span>
        <span className="truncate font-[600]">{group.name}</span>
        <span className={COUNT_BADGE}>{group.symbols.length}</span>
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
    const count = group.symbols.length;
    if (!await confirmAction(count > 0 ? `${group.name} 그룹과 그 안의 ${count}종목을 지웁니다` : `${group.name} 그룹을 지웁니다`, { action: "그룹 지우기", danger: true })) return;
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
  code: SymbolCode;
  index: number;
  last: boolean;
  columns: readonly WatchColumn[];
  template: React.CSSProperties;
  variant: WatchVariant;
  editing: boolean;
  dropBefore: boolean;
  onMoved(code: SymbolCode): void;
  onNaming: GroupNaming["onNaming"];
  drag: { start(): void; over(): void; drop(): void; end(): void };
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
  return (
    <span className={`whitespace-nowrap text-right ${column === "changeRate" && variant === "desktop" ? `rounded-s px-1 py-0.5 text-s font-[550] ${BADGE_CLASS[direction(quote.change)]}` : SIGNED.has(column) ? `text-s font-[550] ${DIR_CLASS[direction(quote.change)]}` : ""}`}>
      {cellText(column, quote, isIndex)}
    </span>
  );
}

function WatchRow({ list, code, index, last, columns, template, variant, editing, dropBefore, onMoved, onNaming, drag }: RowProps) {
  const slot = useSelectionStore((s) => s.activeSlot);
  const cell = useCell(slot);
  const active = cell.symbol === code;
  const others = useWatchlistStore((s) => s.lists).filter((l) => l.id !== list.id);
  const [menu, setMenu] = useState<{ kind: "actions" | "transfer" | "group"; x: number; y: number } | null>(null);
  const root = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const infoQuery = useSymbolInfo(code);
  const info = infoQuery.data;
  const unknown = infoQuery.error instanceof ApiRequestError && infoQuery.error.code === "unknown_symbol";
  const isIndex = isIndexCode(code);
  const name = info?.name ?? code;
  const { quote, limited } = useWatchQuote(code);
  const { moveBy } = useWatchlistStore.getState();
  const values = quote ? columns.map((c) => cellText(c, quote, isIndex)).join(" ") : "";
  const label = unknown ? [name, "찾을 수 없음"] : [name, values, limited ? "실시간 아님" : ""];

  const open = () => {
    useLayoutStore.getState().setSymbol(slot, info ?? { code, nxtEnabled: false });
    if (variant === "phone") useSelectionStore.getState().setPhoneTab("chart");
  };
  const move = (step: -1 | 1) => {
    moveBy(list.id, code, step);
    onMoved(code);
  };
  const remove = () => {
    const undo = removeWithUndo(list.id, code);
    if (undo) useSelectionStore.getState().showToast(`${list.name}에서 뺐습니다: ${name}`, undo);
  };
  const top = () => { useWatchlistStore.getState().move(list.id, code, 0); onMoved(code); };
  const compare = () => {
    const refusal = compareRefusal(cell.chartSettings, code, cell.symbol);
    if (refusal) return useSelectionStore.getState().showToast(refusal === "full" ? "비교 종목은 3개까지입니다" : refusal === "main" ? "현재 종목은 비교에 추가할 수 없습니다" : "이미 비교에 있습니다");
    useLayoutStore.getState().addCompare(slot, code);
    useSelectionStore.getState().showToast(`비교에 추가했습니다: ${name}`);
  };
  const context = (x: number, y: number) => { button.current?.focus(); setMenu({ kind: "actions", x, y }); };
  const items: MenuItem[] = [
    { kind: "heading", label: `${name} ${code}` },
    { kind: "action", label: "이 칸에 열기", icon: <ChartIcon />, hint: "↵", onSelect: open },
    { kind: "action", label: "비교에 추가", icon: <PlusIcon />, hint: "Shift+↵", onSelect: compare },
    { kind: "separator" },
    { kind: "action", label: "맨 위로", icon: <ArrowIcon dir="up" />, hint: "Alt+Home", disabled: index === 0, onSelect: top },
    { kind: "action", label: "그룹으로 옮기기", icon: <ListIcon />, onSelect: () => { button.current?.focus(); setMenu((current) => current && { ...current, kind: "group" }); } },
    { kind: "action", label: "다른 목록에 복사", icon: <CopyIcon />, disabled: others.length === 0, onSelect: () => { button.current?.focus(); setMenu((current) => current && { ...current, kind: "transfer" }); } },
    { kind: "separator" },
    { kind: "action", label: "관심종목에서 빼기", icon: <CloseIcon />, hint: "Del", danger: true, onSelect: remove },
  ];

  return (
    <li
      ref={root}
      data-code={code}
      draggable={variant === "desktop"}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", code);
        drag.start();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        drag.over();
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.drop();
      }}
      onDragEnd={drag.end}
      onContextMenu={variant === "desktop" ? (e) => { e.preventDefault(); context(e.clientX, e.clientY); } : undefined}
      className={`group relative border-l-2 ${active ? "border-l-accent bg-surface" : "border-l-transparent"} ${
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
        className={`${ROW_GRID} h-[34px] w-full items-center pl-2.5 pr-3 text-left hover:bg-surface max-md:h-auto max-md:min-h-[56px] max-md:px-4 max-md:py-2 ${
          editing ? (list.groups.length > 0 ? "max-md:pr-[220px]" : "max-md:pr-[176px]") : ""
        }`}
      >
        <span className={`min-w-0 ${variant === "desktop" ? "flex items-baseline gap-1" : ""} ${unknown ? "opacity-50" : ""}`}>
          <b title={name} className={variant === "desktop" ? "min-w-0 shrink-0 max-w-full truncate font-[550]" : "block truncate font-[550]"}>{name}</b>
          <small className={`${variant === "desktop" ? "w-0 min-w-0 grow truncate" : ""} text-xs text-text-3`}>{symbolSub(code, info)}</small>
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
        className="overflow-auto" items={menu.kind === "actions" ? items : menu.kind === "group" ? groupItems(list, code, onNaming, onMoved) : transferItems(list, code, name, others)} onClose={() => setMenu((current) => current === menu ? null : current)} /> : (
        editing && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
            {list.groups.length > 0 && <GroupMoveMenu list={list} code={code} name={name} onNaming={onNaming} onMoved={onMoved} />}
            <TransferMenu list={list} code={code} name={name} buttonClass="icon-btn h-10 w-10" />
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 위로`} disabled={index === 0} onClick={() => move(-1)}>
              <ArrowIcon dir="up" />
            </button>
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 아래로`} disabled={last} onClick={() => move(1)}>
              <ArrowIcon dir="down" />
            </button>
            <button type="button" className="icon-btn h-10 w-10 text-danger" aria-label={`${name} 지우기`} onClick={remove}>
              <CloseIcon size={18} />
            </button>
          </div>
        )
      )}
    </li>
  );
}

const MENU_LABEL = { actions: "행 동작", group: "그룹으로 옮기기", transfer: "다른 목록으로" } as const;

function groupItems(list: Watchlist, code: SymbolCode, onNaming: GroupNaming["onNaming"], onMoved: RowProps["onMoved"]): MenuItem[] {
  const current = groupOf(list, code)?.id ?? null;
  const assign = (group: string | null) => {
    useWatchlistStore.getState().assignGroup(list.id, code, group);
    if (group !== null) setCollapsed(group, false);
    onMoved(code);
  };
  return [
    { kind: "heading", label: "그룹으로 옮기기" },
    ...list.groups.map((g): MenuItem => ({ kind: "radio", label: g.name, value: g.id, checked: g.id === current, onSelect: () => assign(g.id) })),
    { kind: "radio", label: "그룹 없음", checked: current === null, onSelect: () => assign(null) },
    { kind: "separator" },
    { kind: "action", label: "새 그룹…", icon: <PlusIcon />, disabled: list.groups.length >= MAX_WATCH_GROUPS, onSelect: () => startGroup(list, onNaming, [code]) },
  ];
}

function GroupMoveMenu({ list, code, name, onNaming, onMoved }: { list: Watchlist; code: SymbolCode; name: string; onNaming: GroupNaming["onNaming"]; onMoved: RowProps["onMoved"] }) {
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
      {open && <Menu label={`${name} 그룹으로 옮기기`} items={groupItems(list, code, onNaming, onMoved)} onClose={close} root={root} className="fixed overflow-auto" />}
    </div>
  );
}

function transferItems(list: Watchlist, code: SymbolCode, name: string, others: readonly Watchlist[]): MenuItem[] {
  const send = (to: Watchlist, how: Transfer) => {
    const { showToast } = useSelectionStore.getState();
    if (to.symbols.includes(code) && how === "copy") return showToast(`${name}은 이미 ${to.name}에 있습니다`);
    useWatchlistStore.getState().transfer(list.id, to.id, code, how);
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

function TransferMenu({ list, code, name, buttonClass }: { list: Watchlist; code: SymbolCode; name: string; buttonClass: string }) {
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
            items={transferItems(list, code, name, others)}
            onClose={close}
            root={root}
            className="fixed overflow-auto"
          />}
    </div>
  );
}
