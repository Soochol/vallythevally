import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { MAX_COMPARE, shownScale } from "../../chart/settings";
import { symbolSub } from "../../lib/symbol";
import { type Slot, useCell, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useActiveWatchlist } from "../../stores/watchlist";
import { CloseIcon, SearchIcon } from "../icons";
import { normalizeQuery } from "../search/highlight";
import { GROUP_LABEL, searchList } from "../search/searchList";
import { addButton, AXIS_LOCKED, pressScale, stepIndex } from "./compareForm";

export function ComparePanel({ slot, id, labelledBy, onRemoved }: { slot: Slot; id: string; labelledBy: string; onRemoved(): void }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const { addCompare, removeCompare, setScale } = useLayoutStore.getState();
  const cell = useCell(slot);
  const settings = cell.chartSettings;
  const { compare } = settings;
  const infos = useSymbolInfos(compare);
  const watch = useSymbolInfos(useActiveWatchlist().symbols);
  const queryClient = useQueryClient();
  const ids = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const [input, setInput] = useState("");
  const [active, setActive] = useState(-1);
  const query = normalizeQuery(input);
  const search = useSymbolSearch(query);
  const { rows, selectable, empty } = searchList(query, { watch, recent: [] }, search.data);
  const activeIndex = selectable ? Math.min(active, rows.length - 1) : -1;
  const picked = rows[activeIndex]?.info ?? null;
  const button = addButton(settings, picked, cell.symbol);
  const locked = compare.length > 0;
  const optionId = (i: number) => `${ids}-opt-${i}`;
  const infoOf = (code: string) => infos.find((i) => i.code === code);

  useEffect(() => setActive(query === "" ? -1 : 0), [query, search.data]);
  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const add = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!picked || !button.ok) return;
    queryClient.setQueryData(["symbol", picked.code], picked);
    addCompare(slot, picked.code);
    searchRef.current?.focus();
    searchRef.current?.select();
  };
  const remove = (code: string) => {
    removeCompare(slot, code);
    onRemoved();
  };
  const togglePercent = () => {
    const next = pressScale(settings, "percent");
    if (next) setScale(slot, next);
  };

  let message: string | null = null;
  if (empty && rows.length === 0) message = "종목 이름, 코드, 초성을 입력하세요";
  else if (!empty && search.isError) message = search.error.message;
  else if (!empty && selectable && rows.length === 0) message = "맞는 종목이 없습니다";

  return (
    <form onSubmit={add} noValidate className="flex min-h-0 flex-1 flex-col">
      <div
        role="tabpanel"
        id={id}
        aria-labelledby={labelledBy}
        className="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)] max-md:auto-rows-max max-md:grid-cols-1 max-md:overflow-auto"
      >
        <div className="indicator-catalog min-h-0 overflow-auto border-r border-line p-4 max-md:overflow-visible max-md:border-b max-md:border-r-0">
          <label className="mb-3 flex h-10 items-center gap-2 rounded-m border border-line bg-chart-bg px-3 text-text-3">
            <SearchIcon size={16} />
            <input
              ref={searchRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
                e.preventDefault();
                if (selectable) setActive(stepIndex(activeIndex, e.key === "ArrowDown" ? 1 : -1, rows.length));
              }}
              placeholder="비교할 종목 찾기"
              aria-label="비교할 종목 찾기"
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
            aria-label={empty ? GROUP_LABEL.watch : GROUP_LABEL.result}
            aria-busy={!selectable && !search.isError}
            className="max-md:max-h-[220px] max-md:overflow-auto"
          >
            {empty && rows.length > 0 && (
              <li role="presentation" className="px-2 pb-1 pt-2 text-xs text-text-3">
                {GROUP_LABEL.watch}
              </li>
            )}
            {rows.map(({ info }, i) => (
              <li
                key={info.code}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                aria-disabled={!selectable}
                onClick={() => selectable && setActive(i)}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-m px-2 py-[7px] hover:bg-raised " +
                  "aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:text-accent " +
                  "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent max-md:min-h-[44px]"
                }
              >
                <span className="min-w-0 flex-1 truncate">{info.name}</span>
                <span className="flex-none text-xs font-normal text-text-3">{symbolSub(info.code, info)}</span>
              </li>
            ))}
          </ul>
          {message && <p className="px-2 py-3 text-s text-text-2">{message}</p>}
        </div>

        <div className="flex min-h-[390px] flex-col gap-5 overflow-auto p-6 max-md:min-h-0 max-md:overflow-visible">
          <div>
            <h3 id={`${ids}-current`} className="text-m font-[650]">
              비교 종목{" "}
              <span className="font-normal text-text-3">
                {compare.length}/{MAX_COMPARE}
              </span>
            </h3>
            <p className="mt-1 max-w-[56ch] text-s text-text-2">
              비교 종목을 넣으면 가격축이 화면 왼쪽 끝 봉 기준 % 변화로 바뀝니다. 모두 지우면 원래 축으로 돌아갑니다.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              role="switch"
              aria-checked={shownScale(settings) === "percent"}
              aria-describedby={locked ? `${ids}-locked` : undefined}
              disabled={locked}
              onClick={togglePercent}
              className="group flex w-max items-center gap-2 rounded-m py-1 text-s disabled:cursor-not-allowed disabled:opacity-60 max-md:min-h-[44px]"
            >
              <span
                aria-hidden="true"
                className="flex h-[18px] w-[30px] flex-none items-center rounded-full border border-line bg-chart-bg px-0.5 group-aria-checked:border-accent group-aria-checked:bg-accent"
              >
                <span className="h-3 w-3 rounded-full bg-text-3 motion-safe:transition-transform group-aria-checked:translate-x-3 group-aria-checked:bg-accent-ink" />
              </span>
              가격축을 % 변화로
            </button>
            {locked && (
              <p id={`${ids}-locked`} className="text-s text-text-3">
                {AXIS_LOCKED}
              </p>
            )}
          </div>
          <ul aria-labelledby={`${ids}-current`} className="flex flex-col gap-0.5">
            {compare.map((code, i) => {
              const info = infoOf(code);
              const name = info?.name ?? code;
              return (
                <li key={code} className="flex items-center gap-2 rounded-m px-2 py-1 text-s hover:bg-raised">
                  <span aria-hidden="true" className="h-[3px] w-3 flex-none rounded-s" style={{ background: `var(--cmp-${i + 1})` }} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="flex-none text-text-3">{symbolSub(code, info)}</span>
                  <button
                    type="button"
                    className="icon-btn h-8 w-8 max-md:h-10 max-md:w-10"
                    aria-label={`${name} 지우기`}
                    title="지우기"
                    onClick={() => remove(code)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              );
            })}
            {compare.length === 0 && <li className="px-2 py-1 text-s text-text-3">아직 없습니다. 종목을 찾아 추가하세요.</li>}
          </ul>
        </div>
      </div>

      <div className="ui-dialog-foot flex-wrap">
        <span className="flex items-center gap-2 text-s text-text-3 max-md:hidden">
          <kbd>↑</kbd>
          <kbd>↓</kbd> 종목 고르기 <kbd>Enter</kbd> 추가 <kbd>Esc</kbd> 닫기
        </span>
        <span className="flex-1" />
        {button.reason && (
          <span id={`${ids}-reason`} className="text-s text-text-2 max-md:order-first max-md:w-full">
            {button.reason}
          </span>
        )}
        <button type="button" className="h-8 flex-none rounded-m border border-line px-4 hover:bg-raised" onClick={close}>
          닫기
        </button>
        <button
          type="submit"
          className="btn-primary flex-none disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!button.ok}
          aria-describedby={button.reason ? `${ids}-reason` : undefined}
        >
          {button.label}
        </button>
      </div>
    </form>
  );
}
