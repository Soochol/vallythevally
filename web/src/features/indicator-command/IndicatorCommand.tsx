import { Fragment, useEffect, useId, useRef, type Ref } from "react";
import { indicatorCssColor, isFinancial, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { symbolSub } from "../../lib/symbol";
import { useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { CommandFrame } from "../commands/CommandFrame";
import { CloseIcon, EyeIcon, PlusIcon, SearchIcon } from "../icons";
import { stepIndex } from "../indicator-dialog/compareForm";
import { CompareSection } from "./CompareSection";
import { hasColor, panelLabel, primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { candidateGroup, COMMAND_TABS, commandKey, type IndicatorCommandMode } from "./model";
import { useIndicatorCommand, useIndicatorDraft, type EditableRow, type EditorAction } from "./useIndicatorCommand";
import type { WindowId } from "../../layout/kinds";

export function IndicatorCommand() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicatorCommand" ? <IndicatorCommandBody key={`${dialog.cellId}-${dialog.mode}-${dialog.indicatorId}`} cellId={dialog.cellId} initialMode={dialog.mode} initialIndicator={dialog.indicatorId} /> : null;
}

export function IndicatorCommandBody({ cellId, initialMode, initialIndicator = null }: { cellId: WindowId; initialMode: IndicatorCommandMode; initialIndicator?: string | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const command = useIndicatorCommand(cellId, initialMode, initialIndicator);
  const { cell, mode, input, rows, selected, symbols, search, selectedSymbol, compareButton, editor } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const index = selected ? rows.indexOf(selected) : -1;
  const optionId = (i: number) => `${ids}-option-${i}`;
  const tabId = (value: IndicatorCommandMode) => `${ids}-tab-${value}`;

  useEffect(() => {
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [selected?.key, index]);

  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const submit = (closeAfter = false) => command.submit(closeAfter ? close : refocus);
  const show = (value: IndicatorCommandMode) => { command.show(value); inputRef.current?.focus(); };

  return <CommandFrame width="h-[656px] max-h-[calc(100dvh-32px)] w-[min(976px,calc(100vw-32px))] max-md:h-[85dvh]" labelledBy={`${ids}-title`} onClose={close}>
    <div data-chart-control="" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const action = commandKey(event.nativeEvent);
      if (action.kind === "submit" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(action.close); }
    }}>
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line py-2 pl-4 pr-3">
        <h2 id={`${ids}-title`} className="sr-only">지표·비교 입력창</h2>
        <label className="flex min-w-[160px] flex-1 items-center gap-2 text-m text-text-3">
          <SearchIcon size={18} />
          <input ref={inputRef} autoFocus role="combobox" aria-label="지표·비교 찾기" aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-activedescendant={index >= 0 ? optionId(index) : undefined} aria-autocomplete="list"
            value={input} onChange={(event) => command.type(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey && editor.current) { event.preventDefault(); event.stopPropagation(); editor.current.focus(); return; }
              const action = commandKey(event.nativeEvent);
              if (action.kind !== "move") return;
              event.preventDefault();
              const next = rows[stepIndex(index, action.step, rows.length)];
              if (next) command.select(next);
            }} placeholder="이평 20, bb 20 2, 종목 이름·코드" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-3" />
        </label>
        <div role="tablist" aria-label="지표 창 보기" className="flex gap-1 rounded-m bg-chart-bg p-1" onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = COMMAND_TABS[stepIndex(COMMAND_TABS.findIndex((tab) => tab.mode === mode), event.key === "ArrowRight" ? 1 : -1, COMMAND_TABS.length)];
          if (!next) return;
          command.show(next.mode);
          document.getElementById(tabId(next.mode))?.focus();
        }}>
          {COMMAND_TABS.map((tab) => <button key={tab.mode} id={tabId(tab.mode)} type="button" role="tab" aria-selected={mode === tab.mode} aria-label={tab.mode === "current" ? `${tab.label} ${cell.chartSettings.indicators.length}개` : undefined} aria-controls={`${ids}-panel`} tabIndex={mode === tab.mode ? 0 : -1} onClick={() => show(tab.mode)}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-s px-3 text-s text-text-2 aria-selected:bg-accent aria-selected:font-semibold aria-selected:text-accent-ink">
            {tab.label}{tab.mode === "current" && <span className="rounded-full bg-[var(--hover)] px-1.5 text-xs leading-4">{cell.chartSettings.indicators.length}</span>}
          </button>)}
        </div>
        <button type="button" className="icon-btn" aria-label="입력창 닫기" title="입력창 닫기 (Esc)" onClick={close}><CloseIcon size={16} /></button>
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={tabId(mode)} className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[minmax(100px,180px)_minmax(0,1fr)]">
        <ul id={`${ids}-list`} role="listbox" aria-label="지표·비교 후보" className="min-h-0 overflow-auto border-r border-line p-2 max-md:border-b max-md:border-r-0">
          {rows.map((row, i) => <Fragment key={row.key}>
            {row.group !== rows[i - 1]?.group && <li role="presentation" className="px-2 pb-1 pt-2 text-xs text-text-3">{row.group}</li>}
            <li id={optionId(i)} role="option" aria-label={row.kind === "candidate" ? `${row.candidate.label} 추가 후보` : undefined} aria-selected={row.key === selected?.key} aria-disabled={row.kind === "symbol" && !row.selectable} onClick={() => command.select(row)}
              className="flex min-h-[34px] cursor-pointer items-center gap-2 rounded-m px-2 py-1 text-s hover:bg-raised aria-selected:bg-accent-soft aria-disabled:opacity-50">
              {row.kind === "current" ? <>
                <span aria-hidden="true" className="mx-px size-2.5 flex-none rounded-full" style={{ background: indicatorCssColor(shownColor(row.config.spec, row.config.style.colors)) }} />
                <button type="button" className="min-w-0 flex-1 truncate text-left font-medium" aria-label={`${specName(row.config.spec)} 설정`} onClick={() => command.select(row)}>{specName(row.config.spec)}</button>
                <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} ${row.config.visible ? "숨기기" : "보이기"}`} onClick={(event) => { event.stopPropagation(); useLayoutStore.getState().updateIndicator(cellId, row.config.id, { visible: !row.config.visible }); }}><EyeIcon size={14} off={!row.config.visible} /></button>
                <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} 지우기`} onClick={(event) => { event.stopPropagation(); useLayoutStore.getState().removeIndicator(cellId, row.config.id); }}><CloseIcon size={14} /></button>
              </> : row.kind === "candidate" ? <><span aria-hidden="true" className="flex-none text-text-3"><PlusIcon size={12} /></span><span className="min-w-0 flex-1 font-medium">{row.candidate.label}</span></>
                : <><span className="min-w-0 flex-1 truncate">{row.info.name}</span><span className="text-xs text-text-3">{symbolSub(row.info.code, row.info)}</span></>}
            </li>
          </Fragment>)}
          {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation">{mode === "current"
            ? <EmptyState title="이 칸에 띄운 지표가 없습니다" action="지표 추가" onAction={() => show("add")}>지표 추가 탭에서 고르거나 이름을 입력하세요.</EmptyState>
            : <EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState>}</li>}
          {mode === "compare" && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
          {mode === "compare" && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
        </ul>
        {mode === "compare" ? <CompareSection cellId={cellId} button={compareButton} canAdd={selectedSymbol !== null} onAdd={() => submit()} className="flex min-h-0 flex-col gap-3 overflow-auto p-5" />
          : selected && selected.kind !== "symbol" ? <IndicatorEditor key={selected.key} row={selected} cellId={cellId} actionRef={editor} onCommitted={refocus} />
          : <aside className="p-5 text-s text-text-3">{mode === "current" ? "지표를 고르면 설정을 바꿀 수 있습니다." : "추가할 지표를 고르면 설정을 확인할 수 있습니다."}</aside>}
      </div>
      <footer className="flex flex-none flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-line px-4 py-2 text-xs text-text-3"><span><kbd>↑↓</kbd> 고르기</span><span><kbd>Tab</kbd> 설정</span><span><kbd>Enter</kbd> {mode === "current" ? "적용" : "추가"}하고 계속</span><span><kbd>Shift+Enter</kbd> {mode === "current" ? "적용" : "추가"}하고 닫기</span><span><kbd>Esc</kbd> 되돌리고 닫기</span></footer>
    </div>
  </CommandFrame>;
}

function IndicatorEditor({ row, cellId, actionRef, onCommitted }: { row: EditableRow; cellId: WindowId; actionRef: Ref<EditorAction>; onCommitted(): void }) {
  const controls = useRef<HTMLElement>(null);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { cell, editing, draft, setDraft, validator, check, errors, valid, color, commit } = useIndicatorDraft(cellId, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  const place = editing ? panelLabel(cell.chartSettings.panels, editing.panel) : row.kind === "candidate" ? candidateGroup(row.candidate) : "";

  return <aside ref={controls} className="flex min-h-0 flex-col gap-4 overflow-auto p-5">
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span aria-hidden="true" className="size-3 flex-none rounded-full" style={{ background: indicatorCssColor(color) }} />
      <h3 className="text-l font-semibold">{kind.label}</h3>
      <span className="text-s text-text-3">{place}</span>
      <span className="flex-1" />
      <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
    </div>
    {isFinancial(kind.defaults) && <p className="text-xs text-text-3">분기봉·연봉의 보고기간별 자료입니다. DPS는 연간 전용이며 다른 봉 주기에서는 설정을 보존하고 숨깁니다.</p>}
    <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} />
    {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
    {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
    <div className="mt-auto flex flex-none items-center gap-2">
      <p className="flex-1 text-xs text-text-3">{hasColor(draft.form) && "테마 색은 테마를 바꾸면 함께 바뀝니다"}</p>
      <button type="button" className="btn-primary disabled:opacity-50" disabled={!valid} onClick={() => commit(onCommitted)}>{primaryLabel(editing !== null, draft.form.kind, check.spec)}</button>
    </div>
  </aside>;
}
