import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { compareRefusal } from "../../chart/settings";
import { KIND_LABEL, MARKET_LABEL } from "../../lib/symbol";
import { useLayoutStore } from "../../stores/layout";
import { type SearchPurpose, useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { useActiveWatchlist, useWatchlistStore } from "../../stores/watchlist";
import { type SearchCommand, searchCommandsSnapshot, subscribeSearchCommands } from "../commands/registry";
import { CloseIcon, Icon, ICON_PATHS, SearchIcon } from "../icons";
import { CommandFrame } from "../commands/CommandFrame";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { DEFAULT_SEARCH_COMMANDS } from "./commands";
import { highlight } from "./highlight";
import { GROUP_LABEL, searchList, type SearchGroup } from "./searchList";
import { MARKET_FILTERS, SEARCH_FILTERS, matchesMarket, matchingCommands, type MarketFilter, searchMode } from "./searchMode";
import { QuoteValue, SearchPreview } from "./SearchPreview";
import { useSearchQuotes } from "./useSearchQuotes";

type ResultRow = { kind: "symbol"; info: SymbolInfo; group: SearchGroup } | { kind: "command"; command: SearchCommand; group: "commands" };

export function SearchDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "search" ? <SearchDialogBody purpose={dialog.purpose} /> : null;
}

function SearchDialogBody({ purpose }: { purpose: SearchPurpose }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const slot = useSelectionStore((s) => s.activeSlot);
  const watchlist = useActiveWatchlist();
  const watch = useSymbolInfos(watchlist.symbols);
  const recent = useSymbolInfos(useUiStore((s) => s.prefs.recentSymbols));
  const registered = useSyncExternalStore(subscribeSearchCommands, searchCommandsSnapshot);
  const commands = [...DEFAULT_SEARCH_COMMANDS.filter((c) => !registered.some((r) => r.id === c.id)), ...registered];
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [market, setMarket] = useState<MarketFilter>("all");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mode = searchMode(input);
  const query = mode.query;
  const filters = SEARCH_FILTERS[market];
  const search = useSymbolSearch(mode.kind === "symbols" ? query : "", filters);
  const ids = useId();
  const symbolList = searchList(query, { watch, recent }, search.data, filters);
  const rows: ResultRow[] = [
    ...(mode.kind === "symbols" ? symbolList.rows.filter((row) => query !== "" || matchesMarket(row.info, market)).map((row): ResultRow => ({ kind: "symbol", ...row })) : []),
    ...(query === "" || mode.kind === "commands" ? matchingCommands(commands, query).map((command): ResultRow => ({ kind: "command", command, group: "commands" })) : []),
  ];
  const selectable = mode.kind === "commands" || symbolList.selectable;
  const activeIndex = selectable ? Math.min(active, rows.length - 1) : -1;
  const selected = rows[activeIndex];
  const contents = rows.map((row) => row.kind === "symbol" ? `${row.group}-${row.info.code}` : row.command.id).join("|");
  const { list, quotes, bySymbol } = useSearchQuotes(selectable ? contents : "");
  const optionId = (i: number) => `${ids}-opt-${i}`;

  useEffect(() => setActive(0), [input, market, search.data]);
  useEffect(() => {
    document.getElementById(`${ids}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, ids, contents]);

  const chooseSymbol = (info: SymbolInfo, action: "open" | "watch" | "toggleWatch" | "compare") => {
    queryClient.setQueryData(["symbol", info.code], info);
    const selection = useSelectionStore.getState();
    const lists = useWatchlistStore.getState();
    const included = watchlist.symbols.includes(info.code);
    if (action === "compare") {
      const layout = useLayoutStore.getState();
      const cell = layout.layout.cells.find((c) => c.slot === slot);
      const refusal = cell && compareRefusal(cell.chartSettings, info.code, cell.symbol);
      if (refusal) {
        selection.showToast(refusal === "full" ? "비교 종목은 3개까지입니다" : refusal === "main" ? "현재 종목은 비교에 추가할 수 없습니다" : "이미 비교에 있습니다");
        return;
      }
      layout.addCompare(slot, info.code);
      selection.showToast(`비교에 추가했습니다: ${info.name}`);
    } else if (action === "watch" || action === "toggleWatch") {
      if (included && action === "toggleWatch") {
        lists.remove(watchlist.id, info.code);
        selection.showToast(`${watchlist.name}에서 뺐습니다: ${info.name}`);
      } else if (included) selection.showToast(`${info.name}은 이미 ${watchlist.name}에 있습니다`);
      else {
        lists.add(watchlist.id, info.code);
        selection.showToast(`${watchlist.name}에 넣었습니다: ${info.name}`);
      }
    } else {
      useLayoutStore.getState().setSymbol(slot, info);
      selection.setPhoneTab("chart");
    }
    close();
  };
  const choose = (row: ResultRow, modifiers = { ctrlKey: false, metaKey: false, shiftKey: false }) => {
    if (!selectable) return;
    if (row.kind === "symbol") return chooseSymbol(row.info, modifiers.ctrlKey || modifiers.metaKey ? "toggleWatch" : modifiers.shiftKey ? "compare" : purpose);
    close();
    try {
      void Promise.resolve(row.command.run({ slot, queryClient })).catch((error: unknown) => useSelectionStore.getState().showToast(error instanceof Error ? error.message : "명령을 실행하지 못했습니다"));
    } catch (error) {
      useSelectionStore.getState().showToast(error instanceof Error ? error.message : "명령을 실행하지 못했습니다");
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectable && rows.length) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected) choose(selected, e);
    }
  };
  const resetInput = () => { setInput(""); inputRef.current?.focus(); };

  return <CommandFrame labelledBy={`${ids}-title`} onClose={close} width="h-[500px] w-[min(840px,calc(100vw-32px))] max-md:h-[80dvh]">
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 id={`${ids}-title`} className="sr-only">{purpose === "watch" ? "관심종목에 넣을 종목 검색" : "종목 검색"}</h2>
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <label className="flex min-w-[180px] flex-1 items-center gap-2 text-l text-text-3">
          <SearchIcon size={20} />
          <input ref={inputRef} onKeyDown={onKeyDown} autoFocus value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="종목 이름, 코드, 초성 · >로 명령" aria-label="종목 검색" role="combobox"
            aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3" />
        </label>
        <button type="button" aria-label="검색 닫기" title="검색 닫기 (Esc)" className="icon-btn md:order-last" onClick={close}><CloseIcon /></button>
        {mode.kind === "symbols" && <div role="group" aria-label="시장 필터" className="flex gap-1 max-md:w-full">
          {MARKET_FILTERS.map(({ value, label }) => <button key={value} type="button" aria-pressed={market === value} onClick={() => setMarket(value)} className={`seg-btn px-2 text-xs ${market === value ? "bg-accent-soft text-accent" : "text-text-3"}`}>{label}</button>)}
        </div>}
      </div>
      <div className="flex min-h-0 flex-1">
        <ul ref={list} id={`${ids}-list`} role="listbox" aria-label={purpose === "watch" ? "관심종목에 넣을 종목" : query === "" ? "관심종목과 최근 본 종목" : "검색 결과"}
          aria-busy={!selectable && !search.isError} className="min-w-0 flex-1 overflow-auto p-1">
          {rows.map((row, i) => <Fragment key={row.kind === "symbol" ? `${row.group}-${row.info.code}` : row.command.id}>
            {row.group !== rows[i - 1]?.group && <li role="presentation" className="px-3 pb-1 pt-3 text-xs text-text-3">{row.kind === "command" ? query === "" ? "자주 쓰는 명령" : "명령" : GROUP_LABEL[row.group]}</li>}
            <li id={optionId(i)} role="option" aria-selected={i === activeIndex} aria-disabled={!selectable}
              data-symbol={row.kind === "symbol" && selectable ? row.info.code : undefined}
              onPointerMove={() => selectable && i !== activeIndex && setActive(i)} onClick={(e) => choose(row, e)}
              className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded-m px-3 py-1 text-s aria-selected:bg-accent-soft aria-disabled:cursor-default aria-disabled:opacity-70 max-md:min-h-[44px]">
              {row.kind === "symbol" ? <>
                <span className={`w-4 flex-none ${watchlist.symbols.includes(row.info.code) ? "text-warning" : "text-text-3"}`} aria-label={watchlist.symbols.includes(row.info.code) ? "관심종목" : undefined}>
                  {watchlist.symbols.includes(row.info.code) && <Icon size={14} path={ICON_PATHS.star} fill="currentColor" />}
                </span>
                <span className="min-w-0 flex-1"><span className="font-semibold"><Marked text={row.info.name} query={query} /></span> <span className="whitespace-nowrap text-xs text-text-3"><Marked text={row.info.code} query={query} /></span></span>
                <span className="rounded-s bg-raised px-1 text-xs text-text-3 max-md:hidden">{row.info.kind === "etf" ? KIND_LABEL.etf : MARKET_LABEL[row.info.market]}</span>
                <QuoteValue quote={bySymbol.get(row.info.code)} />
              </> : <><Icon size={16} path="M4 17l5-6 4 3 7-9" /><span className="flex-1"><Marked text={row.command.label} query={query} /></span>{row.command.shortcut && <kbd>{row.command.shortcut}</kbd>}</>}
            </li>
          </Fragment>)}
          {mode.kind === "symbols" && search.isError && query !== "" ? <li role="presentation"><ErrorState message={search.error.message} retry={() => void search.refetch()} /></li> : !selectable && rows.length === 0 ? <li role="presentation"><Skeleton label="종목 찾는 중" /></li> : selectable && rows.length === 0 ? <li role="presentation"><EmptyState title={mode.kind === "symbols" && market !== "all" ? "조건에 맞는 종목이 없습니다" : "맞는 항목이 없습니다"} action="입력 지우기" onAction={resetInput}>종목 이름·코드·초성이나 &gt; 명령을 입력하세요.</EmptyState></li> : null}
          {quotes.isError && <li role="presentation"><ErrorState message="시세를 받지 못했습니다. 종목은 계속 열 수 있습니다." retry={() => void quotes.refetch()} /></li>}
        </ul>
        {selected?.kind === "symbol" ? <SearchPreview key={selected.info.code} purpose={purpose} info={selected.info} quote={bySymbol.get(selected.info.code)} /> : <aside className="w-[280px] flex-none space-y-3 border-l border-line p-4 text-text-2 max-md:hidden"><h3 className="font-semibold text-text">{selected?.kind === "command" ? selected.command.label : "종목·명령 찾기"}</h3><p className="text-s">{selected?.kind === "command" ? "Enter를 눌러 실행합니다" : "종목을 고르면 현재가와 60일 추세를 볼 수 있습니다"}</p><p className="text-xs text-text-3">&gt;로 시작하면 명령만 찾습니다</p></aside>}
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs text-text-3">
        <span><kbd>↑↓</kbd> 고르기</span><span><kbd>↵</kbd> {purpose === "watch" ? "관심종목에 넣기" : "열기"}</span><span><kbd>Ctrl+↵</kbd> 관심종목</span><span><kbd>Shift+↵</kbd> 비교</span><span><kbd>Esc</kbd> 닫기</span>
      </div>
    </div>
  </CommandFrame>;
}

function Marked({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((seg, i) => seg.match ? <mark key={i} className="bg-transparent font-bold text-accent">{seg.text}</mark> : seg.text);
}
