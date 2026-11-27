import { Fragment, type PointerEvent, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { isFinancial, isInvestorFlow, isQuote, isTickCvd, KINDS, specName, type IndicatorKind } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { chartWindow, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartPanelMode } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { CommandFrame } from "../commands/CommandFrame";
import { CloseIcon, SearchIcon } from "../icons";
import { stepIndex } from "../indicator-dialog/compareForm";
import { hasColor, panelLabel, primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { isMaConfig, MaGroupEditor } from "../indicator-dialog/MaGroupEditor";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { Kbd } from "../ui/Kbd";
import { panelDomId, Tabs, tabDomId } from "../ui/Tabs";
import { CompareSection } from "./CompareSection";
import {
  ADD_CATEGORIES,
  BELOW_GROUP,
  candidateGroup,
  commandHints,
  commandKey,
  groupDialogRows,
  INDICATOR_DIALOG_TABS,
  PRICE_GROUP,
  selectedDialogRow,
  type AddCategory,
  type DialogRow,
  type IndicatorCommandMode,
} from "./model";
import { useIndicatorPreview } from "./preview";
import { useIndicatorCommand, useIndicatorDraft, type CandidateRow, type EditorAction } from "./useIndicatorCommand";

export function IndicatorCommand() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicatorCommand" ? <IndicatorCommandBody key={`${dialog.cellId}-${dialog.mode}-${dialog.indicatorId}`} cellId={dialog.cellId} initialMode={dialog.mode} initialIndicator={dialog.indicatorId} /> : null;
}

function specSummary(spec: IndicatorConfig["spec"]): string {
  const label = KINDS[spec.kind].label;
  const name = specName(spec);
  return name.startsWith(label) ? name.slice(label.length).trim() : name;
}

function periodBadge(kind: IndicatorKind): string | null {
  const spec = KINDS[kind].defaults;
  if (isFinancial(spec)) return "분기·연";
  if (isInvestorFlow(spec)) return "일봉+";
  if (isQuote(spec) || isTickCvd(spec)) return "분봉";
  return null;
}

function maGroupSummary(lines: readonly IndicatorConfig[]): string {
  return lines
    .filter(isMaConfig)
    .map((line) => (line.spec.method === "ema" ? `지수 ${line.spec.period}` : `${line.spec.period}`))
    .join(" · ");
}

export function IndicatorCommandBody({ cellId, initialMode, initialIndicator = null }: { cellId: WindowId; initialMode: ChartPanelMode; initialIndicator?: string | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const [initialSettings] = useState(() => chartWindow(useLayoutStore.getState().layout, cellId).chartSettings);
  const [initialIndicatorWindow] = useState(() => useUiStore.getState().prefs.indicatorWindow);
  const [panelSection, setPanelSection] = useState<"indicators" | "compare" | "settings">(
    initialMode === "settings" ? "settings" : initialMode === "compare" ? "compare" : "indicators"
  );
  const [category, setCategory] = useState<AddCategory>("all");
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const command = useIndicatorCommand(cellId, initialMode === "settings" ? defaultIndicatorMode(cellId) : initialMode, initialIndicator);
  const { cell, mode, input, chosen, rows: rawRows, symbols, search, compareButton, editor } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const hasQuery = input.trim() !== "";
  const rows = groupDialogRows(rawRows, mode, category, hasQuery);
  const selected = selectedDialogRow(rows, chosen);
  const index = selected ? rows.indexOf(selected) : -1;
  const optionId = (i: number) => `${ids}-option-${i}`;
  const maCount = cell.chartSettings.indicators.filter(isMaConfig).length;
  const currentTabCount = cell.chartSettings.indicators.filter((item) => !isMaConfig(item)).length + (maCount > 0 ? 1 : 0);

  useEffect(() => {
    if (index >= 0) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  }, [selected?.key, index]);

  const handleClose = (reason?: "escape" | "outside") => {
    if (reason === "escape") {
      useIndicatorPreview.getState().set(cellId, null);
      useLayoutStore.getState().setChartSettings(cellId, initialSettings);
      useUiStore.getState().setIndicatorWindow(initialIndicatorWindow);
    }
    close();
  };
  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const submit = (closeAfter = false) => command.submit(closeAfter ? () => handleClose() : refocus);
  const show = (value: IndicatorCommandMode) => {
    command.show(value);
    setCategory("all");
    inputRef.current?.focus();
  };
  const switchSection = (next: "indicators" | "compare" | "settings") => {
    setPanelSection(next);
    if (next === "compare") command.show("compare");
    else if (next === "indicators") command.show(mode === "compare" ? defaultIndicatorMode(cellId) : mode);
  };
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button, input"))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: dragOffset.x, oy: dragOffset.y };
    setDragging(true);
  };
  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const maxX = Math.max(0, (window.innerWidth - 360) / 2);
    const maxY = Math.max(0, (window.innerHeight - 240) / 2);
    setDragOffset({
      x: Math.round(Math.max(-maxX, Math.min(maxX, d.ox + (e.clientX - d.sx)))),
      y: Math.round(Math.max(-maxY, Math.min(maxY, d.oy + (e.clientY - d.sy)))),
    });
  };
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
  };
  const selectRow = (row: DialogRow) => {
    if (row.kind === "symbol" && !row.selectable) return;
    command.selectKey(row.key);
  };
  const clickOption = (row: DialogRow) => {
    selectRow(row);
    if (row.kind === "symbol" && row.selectable) {
      command.addCompareSymbol(row.info);
    }
  };
  const isMoved = dragOffset.x !== 0 || dragOffset.y !== 0;
  const activeDockMode: ChartPanelMode = panelSection === "settings" ? "settings" : mode;

  return <CommandFrame solid scrim={false} width="ic-frame" labelledBy={`${ids}-title`} onClose={handleClose}>
    <div data-chart-control="" data-dragging={dragging ? "true" : undefined} style={isMoved ? { transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` } : undefined} className="ic-shell flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
      const action = commandKey(event.nativeEvent);
      if (action.kind === "submit" && event.target === inputRef.current) { event.preventDefault(); submit(action.close); }
    }}>
      <div className="ic-top-bar" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <h2 id={`${ids}-title`} className="sr-only">{panelSection === "settings" ? "차트 설정" : "지표·비교 입력창"}</h2>
        <div role="group" aria-label="차트 설정 영역" className="ic-section-seg">
          <button type="button" aria-pressed={panelSection === "indicators"} onClick={() => switchSection("indicators")}>지표</button>
          <button type="button" aria-pressed={panelSection === "compare"} onClick={() => switchSection("compare")}>비교</button>
          <button type="button" aria-pressed={panelSection === "settings"} onClick={() => switchSection("settings")}>차트 설정</button>
        </div>
        <div className="ic-top-actions">
          {isMoved && <button type="button" className="icon-btn" aria-label="가운데로" title="가운데로 복귀" onClick={() => setDragOffset({ x: 0, y: 0 })}>⌖</button>}
          <button type="button" className="cd-mode-btn" aria-label="차트 오른쪽에 도킹" title="차트 오른쪽에 도킹" onClick={() => useSelectionStore.getState().openChartDock(cellId, activeDockMode, selected?.kind === "current" ? selected.config.id : null)}>우측 도킹</button>
          <button type="button" className="icon-btn" aria-label={panelSection === "settings" ? "닫기" : "입력창 닫기"} title="닫기" onClick={() => handleClose()}><CloseIcon size={16} /></button>
        </div>
      </div>

      {panelSection === "settings" ? (
        <div className="ic-settings-body">
          <ChartSettingsSections cellId={cellId} />
          <p className="cs-foot mt-auto pt-2">자동 저장 · Esc로 되돌리고 닫기</p>
        </div>
      ) : <>
      <div className="ic-head">
        <label className="ic-search">
          <SearchIcon size={16} />
          <input ref={inputRef} autoFocus role="combobox" aria-label="지표·비교 찾기" aria-expanded={rows.length > 0} aria-controls={`${ids}-list`} aria-activedescendant={index >= 0 ? optionId(index) : undefined} aria-autocomplete="list"
            value={input} onChange={(event) => command.type(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.shiftKey && editor.current) { event.preventDefault(); event.stopPropagation(); editor.current.focus(); return; }
              const action = commandKey(event.nativeEvent);
              if (action.kind !== "move") return;
              event.preventDefault();
              const next = rows[stepIndex(index, action.step, rows.length)];
              if (next) selectRow(next);
            }} placeholder={mode === "compare" ? "비교할 종목 이름·코드" : "이평 20, bb 20 2, rsi 14"} autoComplete="off" spellCheck={false} />
          {input !== "" && (
            <button type="button" className="ic-search-clear" aria-label="검색어 지우기" onClick={() => { command.type(""); inputRef.current?.focus(); }}>
              <CloseIcon size={12} />
            </button>
          )}
        </label>
      </div>

      {mode === "compare" ? (
        <div className="ic-compare-bar">
          <span>비교 종목</span>
          <span className="ui-badge">{cell.chartSettings.compare.length}/3</span>
        </div>
      ) : (
        <div onClick={(event) => { if (event.detail > 0 && event.target instanceof Element && event.target.closest("[role=tab]")) inputRef.current?.focus(); }}>
          <Tabs label="지표 창 보기" idPrefix={ids} value={mode} className="ic-tabs" onChange={(next) => { command.show(next as IndicatorCommandMode); setCategory("all"); }}
            items={INDICATOR_DIALOG_TABS.map((tab) => tab.mode === "current" ? { id: tab.mode, label: tab.label, count: currentTabCount, ariaLabel: `${tab.label} ${currentTabCount}개` } : { id: tab.mode, label: tab.label })} />
        </div>
      )}

      <div id={panelDomId(ids, mode)} role="tabpanel" aria-labelledby={mode === "compare" ? `${ids}-title` : tabDomId(ids, mode)} className="ic-panel">
        <div className="ic-list-col">
          {mode === "add" && !hasQuery && (
            <div role="group" aria-label="지표 분류" className="ic-cats">
              {ADD_CATEGORIES.map((item) => (
                <button key={item.id} type="button" className="ic-cat" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <ul id={`${ids}-list`} role="listbox" aria-label="지표·비교 후보" className="ic-list">
            {rows.map((row, i) => {
              const hidden = row.kind === "current" ? !row.config.visible : row.kind === "maGroup" ? row.lines.every((line) => !line.visible) : false;
              const groupCount = row.group !== rows[i - 1]?.group ? rows.filter((item) => item.group === row.group).length : null;
              return <Fragment key={row.key}>
                {groupCount !== null && <li role="presentation" className="ic-group"><span>{row.group}</span>{mode === "current" && <span>{groupCount}</span>}</li>}
                <li id={optionId(i)} role="option" aria-label={row.kind === "candidate" ? `${row.candidate.label} 추가 후보` : undefined} aria-selected={row.key === selected?.key} aria-disabled={row.kind === "symbol" && !row.selectable} data-hidden={hidden || undefined} onClick={() => clickOption(row)}
                  className="ic-row">
                  {row.kind === "maGroup" ? <>
                    <button type="button" className="ic-row-text" aria-label="이동평균선 설정" onClick={() => selectRow(row)}>
                      <span className="ic-row-title">이동평균선 <span className="ui-badge" data-tone="accent">{row.lines.length}</span></span>
                      <span className="ic-row-sub">{maGroupSummary(row.lines)}</span>
                    </button>
                    <div className="ic-row-actions">
                      <button type="button" className="icon-btn size-6" aria-label="이동평균선 지우기" onClick={(event) => {
                        event.stopPropagation();
                        const store = useLayoutStore.getState();
                        store.setChartSettings(cellId, { ...cell.chartSettings, indicators: cell.chartSettings.indicators.filter((item) => !isMaConfig(item)) });
                      }}><CloseIcon size={14} /></button>
                    </div>
                  </> : row.kind === "current" ? <>
                    <button type="button" className="ic-row-text" aria-label={`${specName(row.config.spec)} 설정`} onClick={() => selectRow(row)}>
                      <span className="ic-row-title">{KINDS[row.config.spec.kind].label}</span>
                      {specSummary(row.config.spec) !== "" && <span className="ic-row-sub">{specSummary(row.config.spec)}</span>}
                    </button>
                    <div className="ic-row-actions">
                      <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} 지우기`} onClick={(event) => { event.stopPropagation(); removeIndicatorWithUndo(cellId, row.config); }}><CloseIcon size={14} /></button>
                    </div>
                  </> : row.kind === "candidate" ? (() => {
                    const rule = periodBadge(row.candidate.kind);
                    const applied = row.candidate.kind === "ma" ? maCount : cell.chartSettings.indicators.filter((item) => item.spec.kind === row.candidate.kind).length;
                    return <div className="ic-row-text">
                      <span className="ic-row-title">
                        {row.candidate.label}
                        {rule && <span className="ui-badge" data-tone="warning">{rule}</span>}
                        {applied > 0 && <span className="ui-badge" data-tone="accent">{row.candidate.kind === "ma" ? `${applied}선` : "적용됨"}</span>}
                      </span>
                    </div>;
                  })() : <div className="ic-row-text">
                    <span className="ic-row-title">{row.info.name}</span>
                    <span className="ic-row-sub">{symbolSub(row.info.code, row.info)}</span>
                  </div>}
                </li>
              </Fragment>;
            })}
            {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation">{mode === "current"
              ? <EmptyState title="이 칸에 띄운 지표가 없습니다" action="지표 추가" onAction={() => show("add")}>지표 추가 탭에서 고르거나 이름을 입력하세요.</EmptyState>
              : <EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState>}</li>}
            {mode === "compare" && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
            {mode === "compare" && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
          </ul>
        </div>
        {mode === "compare" ? <>
          <CompareSection cellId={cellId} button={compareButton} className="ic-editor" />
          <CommandFooter mode={mode} />
        </>
          : selected?.kind === "maGroup" ? <MaGroupEditorHost cellId={cellId} mode={mode} actionRef={editor} />
          : selected?.kind === "current" ? <CurrentIndicatorEditor key={selected.key} config={selected.config} cellId={cellId} mode={mode} actionRef={editor} />
          : selected?.kind === "candidate" ? <CandidateIndicatorEditor key={selected.key} row={selected} cellId={cellId} mode={mode} actionRef={editor} onCommitted={refocus} />
          : <>
            <aside className="ic-editor text-s text-text-3">{mode === "current" ? "지표를 고르면 설정을 바꿀 수 있습니다." : "추가할 지표를 고르면 설정을 확인할 수 있습니다."}</aside>
            <CommandFooter mode={mode} />
          </>}
      </div>
      </>}
    </div>
  </CommandFrame>;
}

function CommandFooter({ mode, children }: { mode: IndicatorCommandMode; children?: ReactNode }) {
  return <footer className="ic-foot">
    <span className="ic-hints">{commandHints(mode).map((hint) => <span key={hint.keys}><Kbd>{hint.keys}</Kbd> {hint.action}</span>)}</span>
    {children}
  </footer>;
}

function MaGroupEditorHost({ cellId, mode, actionRef }: { cellId: WindowId; mode: IndicatorCommandMode; actionRef: Ref<EditorAction> }) {
  const controls = useRef<HTMLElement>(null);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  useImperativeHandle(actionRef, () => ({ commit: (onCommitted) => onCommitted(), focus }));
  return <>
    <aside ref={controls} className="ic-editor">
      <MaGroupEditor cellId={cellId} />
    </aside>
    <CommandFooter mode={mode} />
  </>;
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
      <div className="ic-ed-head">
        <h3 className="text-l font-semibold">{kind.label}</h3>
        <span className="ic-place-badge">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{check.ok ? "자동 저장됨" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} colorControl="popover" />
      {check.errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode={mode} />
  </>;
}

function CandidateIndicatorEditor({ row, cellId, mode, actionRef, onCommitted }: { row: CandidateRow; cellId: WindowId; mode: IndicatorCommandMode; actionRef: Ref<EditorAction>; onCommitted(): void }) {
  const controls = useRef<HTMLElement>(null);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, check, errors, valid, color, commit } = useIndicatorDraft(cellId, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  const place = draft.placement === "price" ? PRICE_GROUP : candidateGroup(row.candidate);

  return <>
    <aside ref={controls} className="ic-editor">
      <div className="ic-ed-head">
        <h3 className="text-l font-semibold">{kind.label}</h3>
        <span className="ic-place-badge">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} colorControl="popover" />
      {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode={mode}>
      <button type="button" className="btn-primary disabled:opacity-50" disabled={!valid} onClick={() => commit(onCommitted)}>
        {primaryLabel(false, draft.form.kind, check.spec)}
      </button>
    </CommandFooter>
  </>;
}
