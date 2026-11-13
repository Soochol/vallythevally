import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { indicatorCssColor, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import { symbolSub } from "../../lib/symbol";
import { useLayoutStore, type Slot } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore } from "../../stores/selection";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { ChevronIcon, CloseIcon, EyeIcon, PlusIcon, SearchIcon } from "../icons";
import { addButton, stepIndex } from "../indicator-dialog/compareForm";
import { primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { CompareSection } from "../indicator-command/CompareSection";
import { COMMAND_TABS, commandKey, type CommandRow, type IndicatorCommandMode } from "../indicator-command/model";
import { useIndicatorCommand, useIndicatorDraft, type EditableRow, type EditorAction } from "../indicator-command/useIndicatorCommand";

export function IndicatorInspector() {
  const slot = useSelectionStore((s) => s.activeSlot);
  return <InspectorBody key={slot} slot={slot} />;
}

const summary = (spec: IndicatorConfig["spec"]) => {
  const label = KINDS[spec.kind].label;
  const name = specName(spec);
  return name.startsWith(label) ? name.slice(label.length).trim() : name;
};

function InspectorBody({ slot }: { slot: Slot }) {
  const command = useIndicatorCommand(slot, defaultIndicatorMode(slot));
  const { cell, mode, input, rows, selected, symbols, search, editor } = command;
  const [expanded, setExpanded] = useState(false);
  const request = useSelectionStore((s) => s.inspector);
  const inputRef = useRef<HTMLInputElement>(null);
  const revertRef = useRef<() => void>(null);
  const ids = useId();
  const open = expanded && selected ? selected : null;
  const picked = open?.kind === "symbol" && open.selectable ? open.info : null;
  const compareButton = addButton(cell.chartSettings, picked, cell.symbol);
  const tabId = (value: IndicatorCommandMode) => `${ids}-tab-${value}`;
  const rowId = (row: CommandRow) => `${ids}-${row.key}`;

  useEffect(() => {
    const taken = request && useSelectionStore.getState().takeInspectorRequest();
    if (!taken) return;
    command.show(taken.mode, taken.indicatorId);
    setExpanded(taken.indicatorId !== null);
    inputRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (open) document.getElementById(rowId(open))?.scrollIntoView({ block: "nearest" });
  }, [open?.key]);

  const show = (value: IndicatorCommandMode) => { command.show(value); setExpanded(false); };
  const toggle = (row: CommandRow) => {
    if (open?.key === row.key && row.kind !== "symbol") return setExpanded(false);
    command.select(row);
    setExpanded(true);
  };
  const collapse = () => { setExpanded(false); inputRef.current?.focus(); };
  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const submit = () => {
    if (open?.kind === "current") return collapse();
    if (open && command.submit()) refocus();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    if (open.kind === "current") revertRef.current?.();
    collapse();
  };

  return <section data-chart-control="" aria-labelledby={`${ids}-title`} className="flex min-h-0 flex-1 flex-col" onKeyDown={escape}>
    <header className="flex h-[52px] flex-none items-center gap-2 pl-4 pr-2.5">
      <h2 id={`${ids}-title`} className="text-m font-semibold">지표</h2>
      <label className="ml-1.5 flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-m bg-chart-bg px-2.5 text-text-3">
        <SearchIcon size={14} />
        <input ref={inputRef} type="search" aria-label="지표·비교 찾기" value={input} autoComplete="off" spellCheck={false}
          placeholder={mode === "compare" ? "종목 이름·코드" : "이평 20, bb 20 2"}
          className="min-w-0 flex-1 bg-transparent text-s text-text outline-none placeholder:text-text-3"
          onChange={(event) => { command.type(event.target.value); setExpanded(event.target.value.trim() !== ""); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const action = commandKey(event.nativeEvent);
            if (action.kind === "submit") { event.preventDefault(); submit(); return; }
            if (action.kind !== "move") return;
            event.preventDefault();
            const next = rows[stepIndex(open ? rows.indexOf(open) : -1, action.step, rows.length)];
            if (next) { command.select(next); setExpanded(next.kind !== "symbol" || next.selectable); }
          }} />
      </label>
      <button type="button" className="icon-btn" aria-label="지표 패널 닫기" title="지표 패널 닫기" onClick={() => useSelectionStore.getState().showRightPanel("watch")}><CloseIcon size={16} /></button>
    </header>
    <div role="tablist" aria-label="지표 창 보기" className="flex flex-none gap-5 border-b border-line px-4" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = COMMAND_TABS[stepIndex(COMMAND_TABS.findIndex((tab) => tab.mode === mode), event.key === "ArrowRight" ? 1 : -1, COMMAND_TABS.length)];
      if (!next) return;
      show(next.mode);
      document.getElementById(tabId(next.mode))?.focus();
    }}>
      {COMMAND_TABS.map((tab) => <button key={tab.mode} id={tabId(tab.mode)} type="button" role="tab" aria-selected={mode === tab.mode} aria-controls={`${ids}-panel`} tabIndex={mode === tab.mode ? 0 : -1}
        aria-label={tab.mode === "current" ? `${tab.label} ${cell.chartSettings.indicators.length}개` : undefined} onClick={() => { show(tab.mode); inputRef.current?.focus(); }}
        className="-mb-px inline-flex h-[38px] items-center gap-1.5 border-b-2 border-transparent text-s text-text-2 aria-selected:border-accent aria-selected:font-semibold aria-selected:text-accent">
        {tab.label}{tab.mode === "current" && <span className="rounded-full bg-[var(--hover)] px-1.5 text-xs font-normal leading-4 text-text-2">{cell.chartSettings.indicators.length}</span>}
      </button>)}
    </div>
    <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={tabId(mode)} className="flex min-h-0 flex-1 flex-col overflow-auto px-2 pb-2 pt-1">
      <ul aria-label={mode === "compare" ? "비교 후보" : "지표 목록"} className="flex flex-col gap-0.5">
        {rows.map((row, i) => <Fragment key={row.key}>
          {row.group !== rows[i - 1]?.group && <li role="presentation" className="px-2 pb-1 pt-2 text-xs text-text-3">{row.group}</li>}
          <li id={rowId(row)} className={`rounded-l ${open?.key === row.key ? "bg-raised shadow-[inset_0_0_0_1px_var(--accent-soft)]" : ""}`}>
            {row.kind === "symbol"
              ? <button type="button" aria-pressed={selected?.key === row.key && expanded} disabled={!row.selectable} onClick={() => toggle(row)}
                className="flex h-9 w-full items-center gap-2 rounded-l px-2 text-left text-s hover:bg-raised disabled:opacity-50 aria-pressed:bg-accent-soft">
                <span className="min-w-0 flex-1 truncate">{row.info.name}</span><span className="text-xs text-text-3">{symbolSub(row.info.code, row.info)}</span>
              </button>
              : <IndicatorRow slot={slot} row={row} open={open?.key === row.key} onToggle={() => toggle(row)} onRemove={() => { if (open?.key === row.key) setExpanded(false); }}>
                {open?.key === row.key && (row.kind === "current"
                  ? <LiveEditor key={row.key} slot={slot} config={row.config} revertRef={revertRef} />
                  : <AddEditor key={row.key} slot={slot} row={row} actionRef={editor} onAdded={refocus} />)}
              </IndicatorRow>}
          </li>
        </Fragment>)}
        {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation">{mode === "current"
          ? <EmptyState title="이 칸에 띄운 지표가 없습니다" action="지표 추가" onAction={() => show("add")}>지표 추가 탭에서 고르거나 이름을 입력하세요.</EmptyState>
          : <EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState>}</li>}
        {mode === "compare" && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
        {mode === "compare" && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
      </ul>
      {mode === "compare" && <CompareSection slot={slot} button={compareButton} canAdd={picked !== null} onAdd={submit} className="mt-2 flex flex-col gap-3 border-t border-line px-2 pt-3" />}
    </div>
    <p className="sr-only" aria-live="polite">{open ? `${rowName(open)} ${open.kind === "symbol" ? "선택" : "펼침"}` : ""}</p>
    <footer className="flex-none border-t border-line px-4 py-2.5 text-xs text-text-3">바로 반영 · Esc로 되돌리고 닫기</footer>
  </section>;
}

const rowName = (row: CommandRow) => row.kind === "current" ? specName(row.config.spec) : row.kind === "candidate" ? row.candidate.label : row.info.name;

function IndicatorRow({ slot, row, open, onToggle, onRemove, children }: { slot: Slot; row: EditableRow; open: boolean; onToggle(): void; onRemove(): void; children: ReactNode }) {
  const name = rowName(row);
  const label = row.kind === "current" ? KINDS[row.config.spec.kind].label : row.candidate.label;
  return <>
    <div className="flex h-9 items-center gap-2 px-2 text-s">
      {row.kind === "current"
        ? <span aria-hidden="true" className="mx-px size-2.5 flex-none rounded-full" style={{ background: indicatorCssColor(shownColor(row.config.spec, row.config.style.colors)) }} />
        : <span aria-hidden="true" className="flex-none text-text-3"><PlusIcon size={12} /></span>}
      <button type="button" aria-expanded={open} aria-label={row.kind === "current" ? `${name} 설정` : `${name} 추가 후보`} onClick={onToggle} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
        <span className="flex-none font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-2">{row.kind === "current" ? summary(row.config.spec) : ""}</span>
        <span aria-hidden="true" className={`flex-none text-text-2 transition-transform ${open ? "rotate-180" : ""}`}><ChevronIcon /></span>
      </button>
      {row.kind === "current" && <>
        <button type="button" className="icon-btn size-6" aria-label={`${name} ${row.config.visible ? "숨기기" : "보이기"}`} onClick={() => useLayoutStore.getState().updateIndicator(slot, row.config.id, { visible: !row.config.visible })}><EyeIcon size={14} off={!row.config.visible} /></button>
        <button type="button" className="icon-btn size-6" aria-label={`${name} 지우기`} onClick={() => { onRemove(); useLayoutStore.getState().removeIndicator(slot, row.config.id); }}><CloseIcon size={14} /></button>
      </>}
    </div>
    {children}
  </>;
}

const EDITOR = "flex flex-col gap-3 px-3 pb-3 pt-1";

function LiveEditor({ slot, config, revertRef }: { slot: Slot; config: IndicatorConfig; revertRef: Ref<() => void> }) {
  const [initial] = useState(config);
  const { draft, setDraft, validator, check, color, revert } = useLiveIndicatorDraft(slot, initial);
  const kind = KINDS[draft.form.kind];
  useImperativeHandle(revertRef, () => revert);
  return <div role="group" aria-label={`${specName(initial.spec)} 설정`} className={EDITOR}>
    <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} lineSample={false} />
    {check.errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
    {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
  </div>;
}

function AddEditor({ slot, row, actionRef, onAdded }: { slot: Slot; row: EditableRow; actionRef: Ref<EditorAction>; onAdded(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const focus = () => root.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, check, errors, valid, color, commit } = useIndicatorDraft(slot, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  return <div ref={root} role="group" aria-label={`${kind.label} 추가 설정`} className={EDITOR}>
    <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} lineSample={false} />
    {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
    {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
    <button type="button" className="btn-primary self-end disabled:opacity-50" disabled={!valid} onClick={() => { if (commit()) onAdded(); }}>{primaryLabel(false, draft.form.kind, check.spec)}</button>
  </div>;
}
