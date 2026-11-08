import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolSearch } from "../../api/queries";
import { KIND_LABEL, MARKET_LABEL } from "../../lib/symbol";
import { useLayoutStore } from "../../stores/layout";
import { useRecentStore } from "../../stores/recent";
import { useSelectionStore } from "../../stores/selection";
import { SearchIcon } from "../icons";
import { highlight, normalizeQuery } from "./highlight";
import { searchList } from "./searchList";

/** 종목 검색(frontend.md §3.1). 데스크톱은 가운데 대화상자, 휴대폰은 아래에서 올라오는 시트. */
export function SearchDialog() {
  const open = useSelectionStore((s) => s.dialog?.kind === "search");
  return open ? <SearchDialogBody /> : null;
}

function SearchDialogBody() {
  const close = useSelectionStore((s) => s.closeDialog);
  const slot = useSelectionStore((s) => s.activeSlot);
  const recent = useRecentStore((s) => s.recent);
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const query = normalizeQuery(input);
  const search = useSymbolSearch(query);
  const ids = useId();
  const opener = useRef<Element | null>(document.activeElement);

  const { rows, selectable, recent: showingRecent } = searchList(query, recent, search.data);
  const activeIndex = selectable ? Math.min(active, rows.length - 1) : -1;
  const optionId = (i: number) => `${ids}-opt-${i}`;

  useEffect(() => setActive(0), [query, search.data]);
  useEffect(() => {
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  });
  useEffect(() => {
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  const choose = (info: SymbolInfo) => {
    queryClient.setQueryData(["symbol", info.code], info);
    useLayoutStore.getState().setSymbol(slot, info.code);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (selectable && rows.length) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
        return;
      case "Enter": {
        e.preventDefault();
        const row = selectable ? rows[activeIndex] : undefined;
        if (row) choose(row);
        return;
      }
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "Tab":
        e.preventDefault();
        return;
    }
  };

  let message: string | null = null;
  if (showingRecent && rows.length === 0) message = "종목 이름, 코드, 초성을 입력하세요";
  else if (!showingRecent && search.isError) message = search.error.message;
  else if (!showingRecent && selectable && rows.length === 0) {
    message = "맞는 종목이 없습니다. 코드 6자리로도 찾을 수 있습니다";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] pt-[72px] max-md:items-end max-md:pt-0"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        className={
          "flex max-h-[calc(100vh-110px)] w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden rounded-l border border-line bg-surface shadow-dialog " +
          "max-md:max-h-[85dvh] max-md:w-screen max-md:rounded-b-none"
        }
      >
        <h2 id={`${ids}-title`} className="sr-only">
          종목 검색
        </h2>
        <label className="flex h-[46px] flex-none items-center gap-1.5 border-b border-line px-4 text-l text-text-3">
          <SearchIcon />
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="종목 이름, 코드, 초성(ㅅㅅㅈㅈ)"
            aria-label="종목 검색"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={`${ids}-list`}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3"
          />
        </label>
        <ul
          id={`${ids}-list`}
          role="listbox"
          aria-label={showingRecent ? "최근 본 종목" : "검색 결과"}
          aria-busy={!selectable && !search.isError}
          className="max-h-[380px] overflow-auto p-1 max-md:max-h-none max-md:flex-1"
        >
          {showingRecent && rows.length > 0 && (
            <li role="presentation" className="px-3 pb-1 pt-2 text-xs text-text-3">
              최근 본 종목
            </li>
          )}
          {rows.map((s, i) => (
            <li
              key={s.code}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              aria-disabled={!selectable}
              onPointerMove={() => selectable && i !== activeIndex && setActive(i)}
              onClick={() => selectable && choose(s)}
              className="grid cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-3 rounded-m px-3 py-2 aria-selected:bg-accent-soft aria-disabled:cursor-default aria-disabled:opacity-70 max-md:min-h-[44px]"
            >
              <span className="min-w-0 truncate font-semibold">
                <Marked text={s.name} query={query} />
              </span>
              <span className="text-s text-text-3">
                <Marked text={s.code} query={query} />
              </span>
              <span className="text-s text-text-3">
                {MARKET_LABEL[s.market]} {KIND_LABEL[s.kind]}
              </span>
            </li>
          ))}
          {message && (
            <li role="presentation" className="px-3 py-3 text-m text-text-2">
              {message}
            </li>
          )}
        </ul>
        <div className="flex flex-none items-center gap-2 border-t border-line px-4 py-2 text-s text-text-3 max-md:hidden">
          <kbd>↑</kbd>
          <kbd>↓</kbd> 고르기 <kbd>Enter</kbd> 이 칸에 열기 <kbd>Esc</kbd> 닫기
        </div>
      </div>
    </div>
  );
}

function Marked({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((seg, i) =>
    seg.match ? (
      <mark key={i} className="bg-transparent font-bold text-accent">
        {seg.text}
      </mark>
    ) : (
      seg.text
    ),
  );
}
