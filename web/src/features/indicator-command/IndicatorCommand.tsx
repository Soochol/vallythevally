import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { indicatorCssColor, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import { symbolSub } from "../../lib/symbol";
import { chartWindow, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { CommandFrame } from "../commands/CommandFrame";
import { CloseIcon, EyeIcon, PlusIcon, SearchIcon } from "../icons";
import { Kbd } from "../ui/Kbd";
import { panelDomId, Tabs, tabDomId } from "../ui/Tabs";
import { stepIndex } from "../indicator-dialog/compareForm";
import { CompareSection } from "./CompareSection";
import { hasColor, panelLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { BELOW_GROUP, candidateGroup, COMMAND_TABS, commandHints, commandKey, PRICE_GROUP, type CommandRow, type IndicatorCommandMode } from "./model";
import { useIndicatorPreview } from "./preview";
import { useAutoCandidateDraft, useIndicatorCommand, type CandidateRow, type EditorAction } from "./useIndicatorCommand";
import type { WindowId } from "../../layout/kinds";

export function IndicatorCommand() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicatorCommand" ? <IndicatorCommandBody key={`${dialog.cellId}-${dialog.mode}-${dialog.indicatorId}`} cellId={dialog.cellId} initialMode={dialog.mode} initialIndicator={dialog.indicatorId} /> : null;
}

export function IndicatorCommandBody({ cellId, initialMode, initialIndicator = null }: { cellId: WindowId; initialMode: IndicatorCommandMode; initialIndicator?: string | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const [initialSettings] = useState(() => chartWindow(useLayoutStore.getState().layout, cellId).chartSettings);
  const [candidateClick, setCandidateClick] = useState<{ key: string; seq: number } | null>(null);
  const command = useIndicatorCommand(cellId, initialMode, initialIndicator);
  const { cell, mode, input, rows, selected, symbols, search, compareButton, editor } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const index = selected ? rows.indexOf(selected) : -1;
  const optionId = (i: number) => `${ids}-option-${i}`;

  useEffect(() => {
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [selected?.key, index]);

  const handleClose = (reason?: "escape" | "outside") => {
    if (reason === "escape") {
      useIndicatorPreview.getState().set(cellId, null);
      useLayoutStore.getState().setChartSettings(cellId, initialSettings);
    }
    close();
  };
  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const submit = (closeAfter = false) => command.submit(closeAfter ? () => handleClose() : refocus);
  const show = (value: IndicatorCommandMode) => { command.show(value); setCandidateClick(null); inputRef.current?.focus(); };
  const clickOption = (row: CommandRow) => {
    command.select(row);
    if (row.kind === "symbol") {
      if (row.selectable) command.addCompareSymbol(row.info);
      return;
    }
    if (row.kind === "candidate") {
      setCandidateClick((prev) => ({ key: row.key, seq: (prev?.seq ?? 0) + 1 }));
    }
  };
  const clickedThis = selected?.kind === "candidate" && candidateClick?.key === selected.key;

  return <CommandFrame solid scrim={false} width="ic-frame" labelledBy={`${ids}-title`} onClose={handleClose}>
    <div data-chart-control="" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const action = commandKey(event.nativeEvent);
      if (action.kind === "submit" && event.target instanceof HTMLInputElement) { event.preventDefault(); submit(action.close); }
    }}>
      <div className="ic-head">
        <h2 id={`${ids}-title`} className="sr-only">지표·비교 입력창</h2>
        <label className="ic-search">
          <SearchIcon size={18} />
          <input ref={inputRef} autoFocus role="combobox" aria-label="지표·비교 찾기" aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-activedescendant={index >= 0 ? optionId(index) : undefined} aria-autocomplete="list"
            value={input} onChange={(event) => { command.type(event.target.value); setCandidateClick(null); }} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey && editor.current) { event.preventDefault(); event.stopPropagation(); editor.current.focus(); return; }
              const action = commandKey(event.nativeEvent);
              if (action.kind !== "move") return;
              event.preventDefault();
              const next = rows[stepIndex(index, action.step, rows.length)];
              if (next) { command.select(next); setCandidateClick(null); }
            }} placeholder="이평 20, bb 20 2, 종목 이름·코드" autoComplete="off" spellCheck={false} />
        </label>
        <button type="button" className="icon-btn" aria-label="입력창 닫기" title="입력창 닫기" onClick={() => handleClose()}><CloseIcon size={16} /></button>
      </div>
      <div onClick={(event) => { if (event.detail > 0 && event.target instanceof Element && event.target.closest("[role=tab]")) inputRef.current?.focus(); }}>
        <Tabs label="지표 창 보기" idPrefix={ids} value={mode} className="ic-tabs" onChange={(next) => { command.show(next as IndicatorCommandMode); setCandidateClick(null); }}
          items={COMMAND_TABS.map((tab) => tab.mode === "current" ? { id: tab.mode, label: tab.label, count: cell.chartSettings.indicators.length, ariaLabel: `${tab.label} ${cell.chartSettings.indicators.length}개` } : { id: tab.mode, label: tab.label })} />
      </div>
      <div id={panelDomId(ids, mode)} role="tabpanel" aria-labelledby={tabDomId(ids, mode)} className="ic-panel">
        <ul id={`${ids}-list`} role="listbox" aria-label="지표·비교 후보" className="ic-list">
          {rows.map((row, i) => <Fragment key={row.key}>
            {row.group !== rows[i - 1]?.group && <li role="presentation" className="px-2 pb-1 pt-2 text-xs text-text-3">{row.group}</li>}
            <li id={optionId(i)} role="option" aria-label={row.kind === "candidate" ? `${row.candidate.label} 추가 후보` : undefined} aria-selected={row.key === selected?.key} aria-disabled={row.kind === "symbol" && !row.selectable} onClick={() => clickOption(row)}
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
        {mode === "compare" ? <>
          <CompareSection cellId={cellId} button={compareButton} className="ic-editor" />
          <CommandFooter mode={mode} />
        </>
          : selected?.kind === "current" ? <CurrentIndicatorEditor key={selected.key} config={selected.config} cellId={cellId} mode={mode} actionRef={editor} />
          : selected?.kind === "candidate" ? <CandidateIndicatorEditor key={clickedThis ? `${selected.key}:${candidateClick.seq}` : selected.key} row={selected} autoAdd={clickedThis} cellId={cellId} mode={mode} actionRef={editor} />
          : <>
            <aside className="ic-editor text-s text-text-3">{mode === "current" ? "지표를 고르면 설정을 바꿀 수 있습니다." : "추가할 지표를 고르면 설정을 확인할 수 있습니다."}</aside>
            <CommandFooter mode={mode} />
          </>}
      </div>
    </div>
  </CommandFrame>;
}

function CommandFooter({ mode }: { mode: IndicatorCommandMode }) {
  return <footer className="ic-foot">
    <span className="ic-hints">{commandHints(mode).map((hint) => <span key={hint.keys}><Kbd>{hint.keys}</Kbd> {hint.action}</span>)}</span>
  </footer>;
}

function CurrentIndicatorEditor({ config, cellId, mode, actionRef }: { config: IndicatorConfig; cellId: WindowId; mode: IndicatorCommandMode; actionRef: Ref<EditorAction> }) {
  const controls = useRef<HTMLElement>(null);
  const [initial] = useState(config);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, check, color } = useLiveIndicatorDraft(cellId, initial);
  const panels = useLayoutStore((s) => chartWindow(s.layout, cellId).chartSettings.panels);
  const kind = KINDS[draft.form.kind];
  const place = draft.placement === "price" ? PRICE_GROUP : config.panel !== "price" ? panelLabel(panels, config.panel) : BELOW_GROUP;

  useImperativeHandle(actionRef, () => ({ commit: (onCommitted) => onCommitted(), focus }));

  return <>
    <aside ref={controls} className="ic-editor">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span aria-hidden="true" className="size-3 flex-none rounded-full" style={{ background: indicatorCssColor(color) }} />
        <h3 className="text-l font-semibold">{kind.label}</h3>
        <span className="text-s text-text-3">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{check.ok ? "자동 저장됨" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} />
      {check.errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode={mode} />
  </>;
}

function CandidateIndicatorEditor({ row, autoAdd, cellId, mode, actionRef }: { row: CandidateRow; autoAdd: boolean; cellId: WindowId; mode: IndicatorCommandMode; actionRef: Ref<EditorAction> }) {
  const controls = useRef<HTMLElement>(null);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, errors, valid, color, saved } = useAutoCandidateDraft(cellId, row, autoAdd, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  const place = draft.placement === "price" ? PRICE_GROUP : candidateGroup(row.candidate);

  return <>
    <aside ref={controls} className="ic-editor">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span aria-hidden="true" className="size-3 flex-none rounded-full" style={{ background: indicatorCssColor(color) }} />
        <h3 className="text-l font-semibold">{kind.label}</h3>
        <span className="text-s text-text-3">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{saved && valid ? "자동 저장됨" : valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} />
      {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode={mode} />
  </>;
}
