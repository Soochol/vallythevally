import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Watchlist } from "../../api/generated/Watchlist";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfo } from "../../api/queries";
import { direction, formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { isIndexCode, symbolSub } from "../../lib/symbol";
import {
  MAX_WATCHLIST_NAME,
  MAX_WATCHLISTS,
  nameProblem,
  nextListName,
  type Transfer,
  WATCH_COLUMN_LABEL,
  WATCH_COLUMNS,
  type WatchColumn,
} from "../../lib/watchlist";
import { useCell, useLayoutStore } from "../../stores/layout";
import type { WatchQuote } from "../../stores/quoteBook";
import { quoteBook } from "../../stores/realtime";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useActiveWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { ArrowIcon, ChevronIcon, CloseIcon, MoreIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";
import { columnTemplate, type WatchVariant } from "./columns";
import { FundamentalsPanel } from "./FundamentalsPanel";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const ROW_GRID = "grid gap-1";

export function WatchPanel() {
  return (
    <aside aria-label="관심종목" className="flex min-h-0 flex-1 flex-col">
      <WatchHead />
      <WatchList variant="desktop" editing={false} />
      <p className="flex-none border-t border-line px-3 py-2 text-s text-text-3">끌거나 Alt+↑↓로 순서를 바꿉니다</p>
      <FundamentalsPanel />
    </aside>
  );
}

export function PhoneWatch() {
  const shown = useSelectionStore((s) => s.phoneTab === "watch");
  const [editing, setEditing] = useState(false);
  if (!shown) return null;
  return (
    <section aria-label="관심종목" className="fixed inset-x-0 bottom-[56px] top-0 z-30 flex flex-col bg-bg md:hidden">
      <WatchHead>
        <button type="button" className="tb-btn h-9 text-s" aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? "완료" : "편집"}
        </button>
      </WatchHead>
      <WatchList variant="phone" editing={editing} />
    </section>
  );
}

type Naming = { kind: "create" } | { kind: "rename"; id: string };

function WatchHead({ children }: { children?: React.ReactNode }) {
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

  const removeActive = () => {
    if (list.symbols.length > 0 && !window.confirm(`${list.name} 목록과 그 안의 ${list.symbols.length}종목을 지웁니다`)) return;
    const i = lists.findIndex((l) => l.id === list.id);
    const next = lists[i - 1] ?? lists[i + 1];
    useWatchlistStore.getState().removeList(list.id);
    if (next) useUiStore.getState().setActiveWatchlist(next.id);
  };
  const ui = useUiStore.getState();
  const items: MenuItem[] = [
    { kind: "heading", label: "목록" },
    ...lists.map((l): MenuItem => ({ kind: "radio", label: l.name, checked: l.id === list.id, onSelect: () => ui.setActiveWatchlist(l.id) })),
    { kind: "separator" },
    { kind: "action", label: "새 목록", disabled: lists.length >= MAX_WATCHLISTS, onSelect: () => onName({ kind: "create" }) },
    { kind: "action", label: "이름 바꾸기", onSelect: () => onName({ kind: "rename", id: list.id }) },
    { kind: "action", label: "목록 지우기", disabled: lists.length <= 1, onSelect: removeActive },
    { kind: "separator" },
    { kind: "heading", label: "열" },
    ...WATCH_COLUMNS.map((c): MenuItem => ({ kind: "check", label: WATCH_COLUMN_LABEL[c], checked: columns.includes(c), onSelect: () => ui.toggleWatchColumn(c) })),
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
        <p id="watch-name-problem" role="alert" className="absolute left-0 top-[calc(100%+6px)] z-40 rounded-s border border-line bg-surface px-2 py-1 text-s text-up shadow-dialog">
          {problem}
        </p>
      )}
    </form>
  );
}

function WatchList({ variant, editing }: { variant: WatchVariant; editing: boolean }) {
  const list = useActiveWatchlist();
  const symbols = list.symbols;
  const chosen = useUiStore((s) => s.prefs.watchColumns);
  const columns = editing ? [] : chosen;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const onScreen = variant === "desktop" ? desktop : !desktop;
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dragged, setDragged] = useState<SymbolCode | null>(null);
  const ul = useRef<HTMLUListElement>(null);
  const [focusCode, setFocusCode] = useState<SymbolCode | null>(null);
  const template = { gridTemplateColumns: columnTemplate(variant, columns) };

  useEffect(() => (onScreen ? quoteBook.lease(symbols) : undefined), [onScreen, symbols]);

  useEffect(() => {
    if (focusCode === null) return;
    ul.current?.querySelector<HTMLElement>(`[data-code="${CSS.escape(focusCode)}"] [data-main]`)?.focus();
    setFocusCode(null);
  }, [focusCode, symbols]);

  return (
    <>
      <div className={`${ROW_GRID} flex-none px-3 py-1 text-xs text-text-3`} style={template} aria-hidden="true">
        <span>종목</span>
        {columns.map((c) => (
          <span key={c} className="text-right">
            {WATCH_COLUMN_LABEL[c]}
          </span>
        ))}
      </div>
      {symbols.length === 0 && <p className="px-3 py-4 text-m text-text-2">{list.name}에 종목이 없습니다. +로 종목을 넣으세요</p>}
      <ul ref={ul} aria-label={list.name} className="min-h-0 flex-1 overflow-auto" onDragLeave={(e) => e.currentTarget === e.target && setDragOver(null)}>
        {symbols.map((code, i) => (
          <WatchRow
            key={code}
            list={list}
            code={code}
            index={i}
            last={i === symbols.length - 1}
            columns={columns}
            template={template}
            variant={variant}
            editing={editing}
            dropBefore={dragged !== null && dragOver === i}
            onMoved={setFocusCode}
            drag={{
              start: () => setDragged(code),
              over: () => dragged !== null && setDragOver(i),
              drop: () => {
                if (dragged !== null) useWatchlistStore.getState().move(list.id, dragged, i);
                setDragged(null);
                setDragOver(null);
              },
              end: () => {
                setDragged(null);
                setDragOver(null);
              },
            }}
          />
        ))}
      </ul>
    </>
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

function QuoteCell({ column, quote, limited, isIndex }: { column: WatchColumn; quote: Quote | undefined; limited: boolean; isIndex: boolean }) {
  if (column === "price" && limited)
    return (
      <span className="text-right text-text-3">
        {quote && <span className="block">{cellText(column, quote, isIndex)}</span>}
        <small className="whitespace-nowrap text-xs">실시간 아님</small>
      </span>
    );
  if (!quote) return <span className="text-right text-text-3">—</span>;
  return (
    <span className={`text-right ${SIGNED.has(column) ? `text-s font-[550] ${DIR_CLASS[direction(quote.change)]}` : ""}`}>
      {cellText(column, quote, isIndex)}
    </span>
  );
}

function WatchRow({ list, code, index, last, columns, template, variant, editing, dropBefore, onMoved, drag }: RowProps) {
  const slot = useSelectionStore((s) => s.activeSlot);
  const active = useCell(slot).symbol === code;
  const infoQuery = useSymbolInfo(code);
  const info = infoQuery.data;
  const unknown = infoQuery.error instanceof ApiRequestError && infoQuery.error.code === "unknown_symbol";
  const isIndex = isIndexCode(code);
  const name = info?.name ?? code;
  const { quote, limited } = useWatchQuote(code);
  const { remove, moveBy } = useWatchlistStore.getState();
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

  return (
    <li
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
      className={`group relative border-l-2 ${active ? "border-l-accent bg-surface" : "border-l-transparent"} ${
        dropBefore ? "shadow-[inset_0_2px_0_var(--accent)]" : ""
      }`}
    >
      <button
        type="button"
        data-main
        aria-current={active || undefined}
        aria-label={label.filter((part) => part !== "").join(" ")}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={editing ? undefined : open}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          move(e.key === "ArrowUp" ? -1 : 1);
        }}
        style={template}
        className={`${ROW_GRID} w-full items-center px-3 py-[5px] text-left hover:bg-surface max-md:min-h-[56px] max-md:py-2 ${
          editing ? "max-md:pr-[176px]" : ""
        }`}
      >
        <span className={`min-w-0 ${unknown ? "opacity-50" : ""}`}>
          <b className="block truncate font-[550]">{name}</b>
          <small className="text-xs text-text-3">{symbolSub(code, info)}</small>
        </span>
        {unknown ? (
          columns.length > 0 && (
            <span className="text-right text-s text-text-3" style={{ gridColumn: `span ${columns.length}` }}>
              찾을 수 없음
            </span>
          )
        ) : (
          columns.map((c) => <QuoteCell key={c} column={c} quote={quote} limited={limited} isIndex={isIndex} />)
        )}
      </button>
      {variant === "desktop" ? (
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <TransferMenu list={list} code={code} name={name} buttonClass="icon-btn bg-surface" />
          <button type="button" className="icon-btn bg-surface" title="관심종목에서 지우기" aria-label={`${name} 관심종목에서 지우기`} onClick={() => remove(list.id, code)}>
            <CloseIcon />
          </button>
        </div>
      ) : (
        editing && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
            <TransferMenu list={list} code={code} name={name} buttonClass="icon-btn h-10 w-10" />
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 위로`} disabled={index === 0} onClick={() => move(-1)}>
              <ArrowIcon dir="up" />
            </button>
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 아래로`} disabled={last} onClick={() => move(1)}>
              <ArrowIcon dir="down" />
            </button>
            <button type="button" className="icon-btn h-10 w-10 text-up" aria-label={`${name} 지우기`} onClick={() => remove(list.id, code)}>
              <CloseIcon size={18} />
            </button>
          </div>
        )
      )}
    </li>
  );
}

const MENU_GAP = 4;
const MENU_MIN_BELOW = 240;

function menuPlacement({ top, bottom }: { top: number; bottom: number }): React.CSSProperties {
  const below = window.innerHeight - bottom - 2 * MENU_GAP;
  const above = top - 2 * MENU_GAP;
  const cap = window.innerHeight * 0.6;
  return below >= MENU_MIN_BELOW || below >= above
    ? { top: bottom + MENU_GAP, maxHeight: Math.min(cap, below) }
    : { bottom: window.innerHeight - top + MENU_GAP, maxHeight: Math.min(cap, above) };
}

function TransferMenu({ list, code, name, buttonClass }: { list: Watchlist; code: SymbolCode; name: string; buttonClass: string }) {
  const others = useWatchlistStore((s) => s.lists).filter((l) => l.id !== list.id);
  const [at, setAt] = useState<{ right: number; top: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setAt(null);
    if (restoreFocus) button.current?.focus();
  }, []);
  if (others.length === 0) return null;

  const send = (to: Watchlist, how: Transfer) => {
    const { showToast } = useSelectionStore.getState();
    if (to.symbols.includes(code) && how === "copy") return showToast(`${name}은 이미 ${to.name}에 있습니다`);
    useWatchlistStore.getState().transfer(list.id, to.id, code, how);
    showToast(`${how === "move" ? "옮겼습니다" : "복사했습니다"}: ${name} → ${to.name}`);
  };
  const items: MenuItem[] = [
    { kind: "heading", label: "다른 목록으로 옮기기" },
    ...others.map((l): MenuItem => ({ kind: "action", label: l.name, onSelect: () => send(l, "move") })),
    { kind: "separator" },
    { kind: "heading", label: "다른 목록에 복사" },
    ...others.map((l): MenuItem => ({ kind: "action", label: l.name, onSelect: () => send(l, "copy") })),
  ];
  return (
    <div ref={root}>
      <button
        ref={button}
        type="button"
        className={buttonClass}
        title="다른 목록으로 옮기거나 복사"
        aria-label={`${name} 다른 목록으로`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          if (at) return setAt(null);
          const r = button.current!.getBoundingClientRect();
          setAt({ right: window.innerWidth - r.right, top: r.top, bottom: r.bottom });
        }}
      >
        <MoreIcon />
      </button>
      {at &&
        createPortal(
          <Menu
            label={`${name} 다른 목록으로`}
            items={items}
            onClose={close}
            root={root}
            className="fixed overflow-auto"
            style={{ right: at.right, ...menuPlacement(at) }}
          />,
          document.body,
        )}
    </div>
  );
}
