import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { colorsFrom, isFinancial, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { shownScale } from "../../chart/settings";
import { symbolSub } from "../../lib/symbol";
import { useCell, useLayoutStore, type Slot } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useActiveWatchlist } from "../../stores/watchlist";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { CommandFrame } from "../commands/CommandFrame";
import { CloseIcon, EyeIcon, SearchIcon } from "../icons";
import { addButton, AXIS_LOCKED, pressScale, stepIndex } from "../indicator-dialog/compareForm";
import { checkForm, nextColor, panelLabel, primaryLabel, startDraft, type Draft } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm, useValidator } from "../indicator-dialog/IndicatorSettingsForm";
import { normalizeQuery } from "../search/highlight";
import { searchList } from "../search/searchList";
import { commandKey, commandRows, selectedRow, type CommandRow } from "./model";
import { executeCommand } from "./execute";
import { useIndicatorPreview } from "./preview";

type EditorAction = { commit(): boolean; focus(): void };

export function IndicatorCommand() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicatorCommand" ? <IndicatorCommandBody key={`${dialog.slot}-${dialog.mode}`} slot={dialog.slot} initialMode={dialog.mode} /> : null;
}

export function IndicatorCommandBody({ slot, initialMode }: { slot: Slot; initialMode: "indicators" | "compare" }) {
  const cell = useCell(slot);
  const close = useSelectionStore((s) => s.closeDialog);
  const [mode, setMode] = useState(initialMode);
  const [input, setInput] = useState("");
  const [chosen, setChosen] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorAction | null>(null);
  const ids = useId();
  const query = normalizeQuery(input);
  const search = useSymbolSearch(mode === "compare" || input.trim() !== "" ? query : "");
  const watch = useSymbolInfos(useActiveWatchlist().symbols);
  const compareInfos = useSymbolInfos(cell.chartSettings.compare);
  const queryClient = useQueryClient();
  const symbols = searchList(query, { watch, recent: [] }, search.data);
  const rows = commandRows(cell.chartSettings, input, mode, symbols);
  const selected = selectedRow(rows, chosen);
  const index = selected ? rows.indexOf(selected) : -1;
  const optionId = (i: number) => `${ids}-option-${i}`;
  const selectedSymbol = selected?.kind === "symbol" && selected.selectable ? selected.info : null;
  const compareButton = addButton(cell.chartSettings, selectedSymbol, cell.symbol);

  useEffect(() => {
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [selected?.key, index]);

  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const submit = (closeAfter = false) => {
    let added = false;
    if (selected?.kind === "symbol") {
      if (selectedSymbol && compareButton.ok) {
        added = executeCommand(slot, { kind: "compare", code: selectedSymbol.code });
        if (added) queryClient.setQueryData(["symbol", selectedSymbol.code], selectedSymbol);
      }
    } else if (selected) added = editor.current?.commit() ?? false;
    if (added && closeAfter) close();
    else if (added) refocus();
  };
  const select = (row: CommandRow) => { if (row.kind !== "symbol" || row.selectable) setChosen(row.key); };

  return <CommandFrame labelledBy={`${ids}-title`} onClose={close}>
    <div data-chart-control="" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const action = commandKey(event.nativeEvent);
      if (action.kind === "submit" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(action.close); }
    }}>
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 id={`${ids}-title`} className="sr-only">지표·비교 입력창</h2>
        <label className="flex min-w-[160px] flex-1 items-center gap-2 text-m text-text-3">
          <SearchIcon size={18} />
          <input ref={inputRef} autoFocus role="combobox" aria-label="지표·비교 찾기" aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-activedescendant={index >= 0 ? optionId(index) : undefined} aria-autocomplete="list"
            value={input} onChange={(event) => { setInput(event.target.value); setChosen(""); }} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey && editor.current) { event.preventDefault(); event.stopPropagation(); editor.current.focus(); return; }
              const action = commandKey(event.nativeEvent);
              if (action.kind !== "move") return;
              event.preventDefault();
              const next = rows[stepIndex(index, action.step, rows.length)];
              if (next) select(next);
            }} placeholder="이평 20, bb 20 2, 종목 이름·코드" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3" />
        </label>
        <button type="button" className="icon-btn" aria-label="입력창 닫기" title="입력창 닫기 (Esc)" onClick={close}><CloseIcon size={16} /></button>
        <div role="group" aria-label="찾을 항목" className="flex gap-1">
          {(["indicators", "compare"] as const).map((value) => <button key={value} type="button" className="seg-btn text-xs" aria-pressed={mode === value} onClick={() => { setMode(value); setInput(""); setChosen(""); inputRef.current?.focus(); }}>{value === "indicators" ? "지표" : "비교 종목"}</button>)}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_310px] max-md:grid-cols-1 max-md:grid-rows-[minmax(100px,180px)_minmax(0,1fr)]">
        <ul id={`${ids}-list`} role="listbox" aria-label="지표·비교 후보" className="min-h-0 overflow-auto border-r border-line p-1 max-md:border-b max-md:border-r-0">
          {rows.map((row, i) => <Fragment key={row.key}>
            {row.group !== rows[i - 1]?.group && <li role="presentation" className="px-2 pb-1 pt-2 text-xs text-text-3">{row.group}</li>}
            <li id={optionId(i)} role="option" aria-label={row.kind === "candidate" ? `${row.candidate.label} 추가 후보` : undefined} aria-selected={row.key === selected?.key} aria-disabled={row.kind === "symbol" && !row.selectable} onClick={() => select(row)}
              className="flex min-h-[34px] cursor-pointer items-center gap-2 rounded-m px-2 py-1 text-s hover:bg-raised aria-selected:bg-accent-soft aria-disabled:opacity-50">
              {row.kind === "current" ? <>
                <button type="button" className="min-w-0 flex-1 truncate text-left" aria-label={`${specName(row.config.spec)} 설정`} onClick={() => select(row)}>{specName(row.config.spec)}</button>
                <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} ${row.config.visible ? "숨기기" : "보이기"}`} onClick={(event) => { event.stopPropagation(); useLayoutStore.getState().updateIndicator(slot, row.config.id, { visible: !row.config.visible }); }}><EyeIcon size={14} off={!row.config.visible} /></button>
                <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} 지우기`} onClick={(event) => { event.stopPropagation(); useLayoutStore.getState().removeIndicator(slot, row.config.id); }}><CloseIcon size={14} /></button>
              </> : row.kind === "candidate" ? <><span className="min-w-0 flex-1">{row.candidate.label}</span><span className="text-xs text-text-3">{KINDS[row.candidate.kind].place === "price" ? "가격 패널" : "아래 패널"}</span></> : <><span className="min-w-0 flex-1 truncate">{row.info.name}</span><span className="text-xs text-text-3">{symbolSub(row.info.code, row.info)}</span></>}
            </li>
          </Fragment>)}
          {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation"><EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { setInput(""); setChosen(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState></li>}
          {(mode === "compare" || query !== "") && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
          {search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 지표는 계속 고를 수 있습니다." retry={() => void search.refetch()} /></li>}
        </ul>
        {selected?.kind === "symbol" || (mode === "compare" && !selected) ? <aside className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
          <h3 className="text-m font-semibold">비교 종목 {cell.chartSettings.compare.length}/3</h3>
          <p className="text-s text-text-2">비교 종목을 넣으면 가격축이 % 변화로 바뀝니다. 모두 지우면 원래 축으로 돌아갑니다.</p>
          <button type="button" role="switch" aria-checked={shownScale(cell.chartSettings) === "percent"} disabled={cell.chartSettings.compare.length > 0} onClick={() => { const scale = pressScale(cell.chartSettings, "percent"); if (scale) useLayoutStore.getState().setScale(slot, scale); }} className="tb-btn border border-line disabled:opacity-50">가격축을 % 변화로</button>
          {cell.chartSettings.compare.length > 0 && <p className="text-xs text-text-3">{AXIS_LOCKED}</p>}
          <ul className="space-y-1">{cell.chartSettings.compare.map((code) => { const info = compareInfos.find((info) => info.code === code); const name = info?.name ?? code; return <li key={code} className="flex items-center gap-2 text-s"><span className="min-w-0 flex-1 truncate">{name}</span><button type="button" className="icon-btn size-6" aria-label={`${name} 지우기`} onClick={() => useLayoutStore.getState().removeCompare(slot, code)}><CloseIcon size={14} /></button></li>; })}</ul>
          {compareButton.reason && <p className="text-s text-text-2">{compareButton.reason}</p>}
          <button type="button" className="btn-primary mt-auto disabled:opacity-50" disabled={!compareButton.ok || !selectedSymbol} onClick={() => submit()}>{compareButton.label}</button>
        </aside> : selected ? <IndicatorEditor key={selected.key} row={selected} slot={slot} actionRef={editor} onCommitted={refocus} /> : <aside className="p-3 text-s text-text-3">지표나 비교 종목을 고르면 설정을 확인할 수 있습니다.</aside>}
      </div>
      <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-xs text-text-3"><span><kbd>↑↓</kbd> 고르기</span><span><kbd>Tab</kbd> 설정</span><span><kbd>Enter</kbd> 추가하고 계속</span><span><kbd>Shift+Enter</kbd> 추가하고 닫기</span><span><kbd>Esc</kbd> 되돌리고 닫기</span></footer>
    </div>
  </CommandFrame>;
}

function IndicatorEditor({ row, slot, actionRef, onCommitted }: { row: Exclude<CommandRow, { kind: "symbol" }>; slot: Slot; actionRef: Ref<EditorAction>; onCommitted(): void }) {
  const cell = useCell(slot);
  const editing = row.kind === "current" ? row.config : null;
  const candidate = row.kind === "candidate" ? row.candidate : null;
  const [draft, setDraft] = useState<Draft>(() => editing ? startDraft(editing, editing.spec.kind) : { ...startDraft(null, candidate!.kind), form: candidate!.form });
  const controls = useRef<HTMLElement>(null);
  const [previewIds] = useState(() => [crypto.randomUUID(), crypto.randomUUID()] as const);
  const validator = useValidator();
  const check = checkForm(draft.form, typeof validator === "function" ? validator : null);
  const errors = [...(candidate?.errors.filter((error) => error.field === "") ?? []), ...check.errors];
  const valid = check.ok && errors.length === 0;
  const color = draft.color === "auto" ? nextColor(cell.chartSettings.indicators) : draft.color;
  const colors = editing && color === shownColor(editing.spec, editing.style.colors) ? editing.style.colors : check.spec ? colorsFrom(check.spec, color) : [];
  const style = { colors, width: draft.width };

  useEffect(() => {
    useIndicatorPreview.getState().set(slot, valid && check.spec ? editing ? { kind: "edit", id: editing.id, spec: check.spec, style } : { kind: "add", id: previewIds[0], panelId: previewIds[1], spec: check.spec, style } : null);
  }, [draft, validator, cell.chartSettings.indicators, slot]);
  useEffect(() => () => useIndicatorPreview.getState().set(slot, null), [slot]);

  const commit = () => {
    if (!valid || !check.spec) return false;
    const committed = executeCommand(slot, { kind: "indicator", id: editing?.id ?? null, spec: check.spec, style });
    if (committed && !editing) setDraft((draft) => ({ ...draft, color: "auto" }));
    return committed;
  };
  useImperativeHandle(actionRef, () => ({ commit, focus: () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus() }));

  return <aside ref={controls} className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
    <div><h3 className="text-m font-semibold">{KINDS[draft.form.kind].label}</h3><p className="mt-1 text-xs text-accent">{valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>{editing && <p className="text-xs text-text-3">{panelLabel(cell.chartSettings.panels, editing.panel)}</p>}{isFinancial(KINDS[draft.form.kind].defaults) && <p className="mt-2 text-xs text-text-3">분기봉·연봉의 보고기간별 자료입니다. DPS는 연간 전용이며 다른 봉 주기에서는 설정을 보존하고 숨깁니다.</p>}</div>
    <div role="group" aria-label="설정값" className="flex flex-col gap-3"><IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} />
      {errors.filter((error) => !KINDS[draft.form.kind].fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
    </div>
    <button type="button" className="btn-primary mt-auto flex-none disabled:opacity-50" disabled={!valid} onClick={() => { if (commit()) onCommitted(); }}>{primaryLabel(editing !== null, draft.form.kind, check.spec)}</button>
  </aside>;
}
