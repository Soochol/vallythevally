import { useEffect, useRef, useState } from "react";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { ApiRequestError } from "../../api/http";
import { useQuotes, useSymbolInfo } from "../../api/queries";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { isIndexCode, symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import { ArrowIcon, ChevronRightIcon, CloseIcon, PlusIcon } from "../icons";

const DIR_CLASS = { up: "text-up", down: "text-down", flat: "text-text-2" } as const;
const COLS = "grid grid-cols-[minmax(0,1fr)_76px_60px] gap-1 max-md:grid-cols-[minmax(0,1fr)_96px_72px]";

export function WatchPanel() {
  const collapsed = useUiStore((s) => s.prefs.watchCollapsed);
  const toggle = useUiStore((s) => s.toggleWatch);
  if (collapsed) {
    return (
      <aside aria-label="관심종목" className="flex flex-col items-center border-l border-line bg-bg pt-1.5 [grid-area:watch] max-md:hidden">
        <button type="button" className="icon-btn" title="관심종목 펴기 (Alt+W)" aria-label="관심종목 펴기" aria-expanded={false} onClick={toggle}>
          <ChevronRightIcon flip />
        </button>
      </aside>
    );
  }
  return (
    <aside aria-label="관심종목" className="flex min-h-0 flex-col border-l border-line bg-bg [grid-area:watch] max-md:hidden">
      <WatchHead>
        <button type="button" className="icon-btn" title="관심종목 접기 (Alt+W)" aria-label="관심종목 접기" aria-expanded onClick={toggle}>
          <ChevronRightIcon />
        </button>
      </WatchHead>
      <WatchList variant="desktop" editing={false} />
      <p className="flex-none border-t border-line px-3 py-2 text-s text-text-3">끌거나 Alt+↑↓로 순서를 바꿉니다</p>
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

function WatchHead({ children }: { children: React.ReactNode }) {
  const count = useWatchlistStore((s) => s.symbols.length);
  const openSearch = useSelectionStore((s) => s.openSearch);
  return (
    <div className="flex h-9 flex-none items-center gap-1 border-b border-line pl-3 pr-1 max-md:h-12">
      <h2 className="text-m font-[650]">관심종목</h2>
      <span className="text-s text-text-3">{count}종목</span>
      <span className="flex-1" />
      <button
        type="button"
        className="icon-btn max-md:h-10 max-md:w-10"
        title="관심종목에 넣기"
        aria-label="관심종목에 넣기"
        aria-haspopup="dialog"
        onClick={() => openSearch("watch")}
      >
        <PlusIcon />
      </button>
      {children}
    </div>
  );
}

type Variant = "desktop" | "phone";

function WatchList({ variant, editing }: { variant: Variant; editing: boolean }) {
  const symbols = useWatchlistStore((s) => s.symbols);
  const quotes = useQuotes(symbols).data;
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dragged, setDragged] = useState<SymbolCode | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const [focusCode, setFocusCode] = useState<SymbolCode | null>(null);

  useEffect(() => {
    if (focusCode === null) return;
    list.current?.querySelector<HTMLElement>(`[data-code="${CSS.escape(focusCode)}"] [data-main]`)?.focus();
    setFocusCode(null);
  }, [focusCode, symbols]);

  return (
    <>
      <div className={`${COLS} flex-none px-3 py-1 text-xs text-text-3`} aria-hidden="true">
        <span>종목</span>
        <span className="text-right">현재가</span>
        <span className="text-right">등락률</span>
      </div>
      {symbols.length === 0 && <p className="px-3 py-4 text-m text-text-2">관심종목이 없습니다. +로 종목을 넣으세요</p>}
      <ul ref={list} className="min-h-0 flex-1 overflow-auto" onDragLeave={(e) => e.currentTarget === e.target && setDragOver(null)}>
        {symbols.map((code, i) => (
          <WatchRow
            key={code}
            code={code}
            index={i}
            last={i === symbols.length - 1}
            quote={quotes?.get(code)}
            variant={variant}
            editing={editing}
            dropBefore={dragged !== null && dragOver === i}
            onMoved={setFocusCode}
            drag={{
              start: () => setDragged(code),
              over: () => dragged !== null && setDragOver(i),
              drop: () => {
                if (dragged !== null) useWatchlistStore.getState().move(dragged, i);
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
  code: SymbolCode;
  index: number;
  last: boolean;
  quote: Quote | undefined;
  variant: Variant;
  editing: boolean;
  dropBefore: boolean;
  onMoved(code: SymbolCode): void;
  drag: { start(): void; over(): void; drop(): void; end(): void };
}

function WatchRow({ code, index, last, quote, variant, editing, dropBefore, onMoved, drag }: RowProps) {
  const slot = useSelectionStore((s) => s.activeSlot);
  const active = useCell(slot).symbol === code;
  const infoQuery = useSymbolInfo(code);
  const info = infoQuery.data;
  const unknown = infoQuery.error instanceof ApiRequestError && infoQuery.error.code === "unknown_symbol";
  const isIndex = isIndexCode(code);
  const name = info?.name ?? code;
  const { remove, moveBy } = useWatchlistStore.getState();

  const open = () => {
    useLayoutStore.getState().setSymbol(slot, info ?? { code, nxtEnabled: false });
    if (variant === "phone") useSelectionStore.getState().setPhoneTab("chart");
  };
  const move = (step: -1 | 1) => {
    moveBy(code, step);
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
        aria-label={`${name} ${unknown ? "찾을 수 없음" : quote ? `${formatPrice(quote.price, isIndex)} ${formatPercent(quote.changeRate)}` : ""}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={editing ? undefined : open}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          move(e.key === "ArrowUp" ? -1 : 1);
        }}
        className={`${COLS} w-full items-center px-3 py-[5px] text-left hover:bg-surface max-md:min-h-[56px] max-md:py-2 ${
          editing ? "max-md:pr-[132px]" : ""
        }`}
      >
        <span className={`min-w-0 ${unknown ? "opacity-50" : ""}`}>
          <b className="block truncate font-[550]">{name}</b>
          <small className="text-xs text-text-3">{symbolSub(code, info)}</small>
        </span>
        {unknown ? (
          <span className="col-span-2 text-right text-s text-text-3">찾을 수 없음</span>
        ) : quote ? (
          <>
            <span className="text-right">{formatPrice(quote.price, isIndex)}</span>
            <span className={`text-right text-s font-[550] ${DIR_CLASS[direction(quote.changeRate)]}`}>{formatPercent(quote.changeRate)}</span>
          </>
        ) : (
          <>
            <span className="text-right text-text-3">—</span>
            <span className="text-right text-s text-text-3">—</span>
          </>
        )}
      </button>
      {variant === "desktop" ? (
        <button
          type="button"
          className="icon-btn absolute right-1 top-1/2 -translate-y-1/2 bg-surface opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          title="관심종목에서 지우기"
          aria-label={`${name} 관심종목에서 지우기`}
          onClick={() => remove(code)}
        >
          <CloseIcon />
        </button>
      ) : (
        editing && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 위로`} disabled={index === 0} onClick={() => move(-1)}>
              <ArrowIcon dir="up" />
            </button>
            <button type="button" className="icon-btn h-10 w-10" aria-label={`${name} 아래로`} disabled={last} onClick={() => move(1)}>
              <ArrowIcon dir="down" />
            </button>
            <button type="button" className="icon-btn h-10 w-10 text-up" aria-label={`${name} 지우기`} onClick={() => remove(code)}>
              <CloseIcon size={18} />
            </button>
          </div>
        )
      )}
    </li>
  );
}
