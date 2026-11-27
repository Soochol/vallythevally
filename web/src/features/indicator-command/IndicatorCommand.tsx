import { Fragment, type PointerEvent, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { colorLine, indicatorCssColor, isFinancial, isInvestorFlow, isQuote, isTickCvd, KINDS, shownColor, specName, type IndicatorKind } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { chartWindow, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartPanelMode } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { CommandFrame } from "../commands/CommandFrame";
import { ChevronIcon, CloseIcon, EyeIcon, SearchIcon } from "../icons";
import { stepIndex } from "../indicator-dialog/compareForm";
import { hasColor, panelLabel, primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { Kbd } from "../ui/Kbd";
import { CompareSection } from "./CompareSection";
import {
  BELOW_GROUP,
  candidateGroup,
  commandHints,
  commandKey,
  currentKey,
  PRICE_GROUP,
  selectedTreeRow,
  unifiedIndicatorRows,
  type IndicatorCommandMode,
  type TreeCandidateRow,
  type TreeDialogRow,
} from "./model";
import { useIndicatorPreview } from "./preview";
import { useIndicatorCommand, useIndicatorDraft, type EditorAction } from "./useIndicatorCommand";

export function IndicatorCommand() {
  const dialog = useSelectionStore((s) => s.dialog);
  return dialog?.kind === "indicatorCommand" ? <IndicatorCommandBody key={`${dialog.cellId}-${dialog.indicatorId}`} cellId={dialog.cellId} initialMode={dialog.mode} initialIndicator={dialog.indicatorId} /> : null;
}

function periodBadge(kind: IndicatorKind): string | null {
  const spec = KINDS[kind].defaults;
  if (isFinancial(spec)) return "분기·연";
  if (isInvestorFlow(spec)) return "일봉+";
  if (isQuote(spec) || isTickCvd(spec)) return "분봉";
  return null;
}

function childLabel(spec: IndicatorConfig["spec"]): string {
  const label = KINDS[spec.kind].label;
  const full = specName(spec);
  if (full === label) return label;
  const detail = full.startsWith(label) ? full.slice(label.length).trim() : full;
  return `${label} (${detail})`;
}

export function IndicatorCommandBody({ cellId, initialMode, initialIndicator = null }: { cellId: WindowId; initialMode: ChartPanelMode; initialIndicator?: string | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const [initialSettings] = useState(() => chartWindow(useLayoutStore.getState().layout, cellId).chartSettings);
  const [initialIndicatorWindow] = useState(() => useUiStore.getState().prefs.indicatorWindow);
  const [panelSection, setPanelSection] = useState<"indicators" | "settings" | "compare">(
    initialMode === "settings" ? "settings" : initialMode === "compare" ? "compare" : "indicators"
  );
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<IndicatorKind>>(() => new Set());
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const command = useIndicatorCommand(cellId, initialMode === "settings" ? defaultIndicatorMode(cellId) : initialMode, initialIndicator);
  const { cell, mode, input, chosen, rows: rawRows, symbols, search, compareButton, editor } = command;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const hasQuery = input.trim() !== "";
  const rows: TreeDialogRow[] = mode === "compare"
    ? rawRows.filter((row): row is Extract<typeof row, { kind: "symbol" }> => row.kind === "symbol")
    : unifiedIndicatorRows(cell.chartSettings, input, collapsedKinds);
  const preferCurrent = mode === "current" && !hasQuery;
  const selected = selectedTreeRow(rows, chosen, preferCurrent);
  const index = selected ? rows.indexOf(selected) : -1;
  const optionId = (i: number) => `${ids}-option-${i}`;

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

  const expandKind = (kind: IndicatorKind) => {
    setCollapsedKinds((prev) => {
      if (!prev.has(kind)) return prev;
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
  };

  const toggleKind = (kind: IndicatorKind) => {
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };

  const afterAdd = (kind: IndicatorKind, createdId?: string, focusSearch = false) => {
    expandKind(kind);
    if (createdId) command.selectKey(currentKey(createdId));
    if (focusSearch) refocus();
  };

  const submit = (closeAfter = false) => {
    const targetKind = selected?.kind === "candidate" ? selected.candidate.kind : null;
    command.submit(
      closeAfter
        ? () => handleClose()
        : (createdId) => {
            if (targetKind) afterAdd(targetKind, createdId, true);
            else refocus();
          },
    );
  };

  useEffect(() => {
    const nextSection = initialMode === "settings" ? "settings" : initialMode === "compare" ? "compare" : "indicators";
    setPanelSection(nextSection);
    if (initialMode !== "settings") command.show(initialMode, initialIndicator);
  }, [initialMode, initialIndicator]);

  const switchSection = (next: "indicators" | "settings" | "compare") => {
    setPanelSection(next);
    const nextMode: ChartPanelMode = next === "settings" ? "settings" : next === "compare" ? "compare" : mode === "compare" ? defaultIndicatorMode(cellId) : mode;
    useSelectionStore.getState().setIndicatorDialogMode(nextMode);
    if (nextMode !== "settings") command.show(nextMode);
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
  const selectRow = (row: TreeDialogRow) => {
    if (row.kind === "symbol" && !row.selectable) return;
    command.selectKey(row.key);
  };
  const clickOption = (row: TreeDialogRow) => {
    selectRow(row);
    if (row.kind === "symbol" && row.selectable) {
      command.addCompareSymbol(row.info);
    }
  };
  const isMoved = dragOffset.x !== 0 || dragOffset.y !== 0;
  const activeDockMode: ChartPanelMode = panelSection === "settings" ? "settings" : mode;
  const footerMode: IndicatorCommandMode = mode === "compare" ? "compare" : selected?.kind === "candidate" ? "add" : "current";

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
          <button type="button" aria-label="차트 설정" aria-pressed={panelSection === "settings"} onClick={() => switchSection("settings")}>차트</button>
          <button type="button" aria-pressed={panelSection === "compare"} onClick={() => switchSection("compare")}>비교</button>
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
        </div>
      ) : <>
      <div className={`ic-head ${mode !== "compare" ? "ic-head-bordered" : ""}`}>
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
            }} placeholder={mode === "compare" ? "비교할 종목 이름·코드" : "지표 검색 (예: 이평 20, bb 20 2, rsi 14)"} autoComplete="off" spellCheck={false} />
          {input !== "" && (
            <button type="button" className="ic-search-clear" aria-label="검색어 지우기" onClick={() => { command.type(""); inputRef.current?.focus(); }}>
              <CloseIcon size={12} />
            </button>
          )}
        </label>
      </div>

      {mode === "compare" && (
        <div className="ic-compare-bar">
          <span>비교 종목</span>
          <span className="ui-badge">{cell.chartSettings.compare.length}/3</span>
        </div>
      )}

      <div className="ic-panel">
        <div className="ic-list-col">
          <ul id={`${ids}-list`} role="listbox" aria-label="지표·비교 후보" className="ic-list">
            {rows.map((row, i) => {
              const hidden = row.kind === "current" ? !row.config.visible : false;
              const showGroup = row.group !== rows[i - 1]?.group;
              return <Fragment key={row.key}>
                {showGroup && <li role="presentation" className="ic-group"><span>{row.group}</span></li>}
                {row.kind === "candidate" ? (() => {
                  const rule = periodBadge(row.candidate.kind);
                  const hasChildren = row.instanceCount > 0;
                  const collapsed = !hasQuery && collapsedKinds.has(row.candidate.kind);
                  return (
                    <li id={optionId(i)} role="option" aria-label={`${row.candidate.label} 추가 후보`} aria-selected={row.key === selected?.key} data-has-children={hasChildren || undefined} onClick={() => clickOption(row)}
                      className="ic-row ic-tree-parent">
                      {hasChildren ? (
                        <button type="button" className="ic-tree-chev" aria-label={collapsed ? `${KINDS[row.candidate.kind].label} 인스턴스 펼치기` : `${KINDS[row.candidate.kind].label} 인스턴스 접기`} aria-expanded={!collapsed} data-collapsed={collapsed || undefined} onClick={(event) => { event.stopPropagation(); toggleKind(row.candidate.kind); }}>
                          <ChevronIcon size={12} />
                        </button>
                      ) : (
                        <span aria-hidden="true" className="ic-tree-dot-spacer"><i /></span>
                      )}
                      <div className="ic-row-text">
                        <span className="ic-row-title">
                          <span className="ic-row-title-label">{hasQuery ? row.candidate.label : KINDS[row.candidate.kind].label}</span>
                          {rule && <span className="ui-badge" data-tone="warning">{rule}</span>}
                        </span>
                      </div>
                      <span aria-hidden="true" className="ic-tree-add-cue">+ 추가</span>
                      {hasChildren && <span className="ui-badge" data-tone="accent">{row.instanceCount}</span>}
                    </li>
                  );
                })() : row.kind === "current" ? (() => {
                  const full = specName(row.config.spec);
                  const hasDot = colorLine(row.config.spec) !== null;
                  return (
                    <li id={optionId(i)} role="option" aria-selected={row.key === selected?.key} data-hidden={hidden || undefined} onClick={() => clickOption(row)}
                      className="ic-row ic-tree-child">
                      <span aria-hidden="true" className="ic-tree-idx">#{row.index}</span>
                      <span aria-hidden="true" className="ic-color-dot" style={{ background: hasDot ? indicatorCssColor(shownColor(row.config.spec, row.config.style.colors)) : "var(--text-3)" }} />
                      <button type="button" className="ic-row-text" aria-label={`${full} 설정`} title={full} onClick={() => selectRow(row)}>
                        <span className="ic-tree-child-label">{childLabel(row.config.spec)}</span>
                      </button>
                      <div className="ic-row-actions">
                        <button type="button" className="icon-btn size-6" aria-label={`${full} ${row.config.visible ? "숨기기" : "보이기"}`} title={row.config.visible ? "숨기기" : "보이기"} onClick={(event) => {
                          event.stopPropagation();
                          useLayoutStore.getState().updateIndicator(cellId, row.config.id, { visible: !row.config.visible });
                        }}><EyeIcon size={13} off={!row.config.visible} /></button>
                        <button type="button" className="icon-btn size-6" aria-label={`${full} 지우기`} title="지우기" onClick={(event) => {
                          event.stopPropagation();
                          removeIndicatorWithUndo(cellId, row.config);
                        }}><CloseIcon size={13} /></button>
                      </div>
                    </li>
                  );
                })() : (
                  <li id={optionId(i)} role="option" aria-selected={row.key === selected?.key} aria-disabled={!row.selectable} onClick={() => clickOption(row)} className="ic-row">
                    <div className="ic-row-text">
                      <span className="ic-row-title">{row.info.name}</span>
                      <span className="ic-row-sub">{symbolSub(row.info.code, row.info)}</span>
                    </div>
                  </li>
                )}
              </Fragment>;
            })}
            {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation">
              <EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState>
            </li>}
            {mode === "compare" && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
            {mode === "compare" && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
          </ul>
        </div>
        {mode === "compare" ? <>
          <CompareSection cellId={cellId} button={compareButton} className="ic-editor" />
          <CommandFooter mode="compare" />
        </>
          : selected?.kind === "current" ? <CurrentIndicatorEditor key={selected.key} config={selected.config} instanceIndex={selected.index} cellId={cellId} actionRef={editor} />
          : selected?.kind === "candidate" ? <CandidateIndicatorEditor key={`${selected.key}:${selected.instanceCount}`} row={selected} cellId={cellId} actionRef={editor} onCommitted={(createdId) => afterAdd(selected.candidate.kind, createdId, false)} />
          : <>
            <aside className="ic-editor text-s text-text-3">지표를 고르면 설정하거나 추가할 수 있습니다.</aside>
            <CommandFooter mode={footerMode} />
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

function CurrentIndicatorEditor({ config, instanceIndex, cellId, actionRef }: { config: IndicatorConfig; instanceIndex: number; cellId: WindowId; actionRef: Ref<EditorAction> }) {
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
        <span className="ui-badge" data-tone="accent">#{instanceIndex}</span>
        <span className="ic-place-badge">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{check.ok ? "자동 저장됨" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} colorControl="popover" />
      {check.errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode="current" />
  </>;
}

function CandidateIndicatorEditor({ row, cellId, actionRef, onCommitted }: { row: TreeCandidateRow; cellId: WindowId; actionRef: Ref<EditorAction>; onCommitted(createdId?: string): void }) {
  const controls = useRef<HTMLElement>(null);
  const focus = () => controls.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, check, errors, valid, color, commit } = useIndicatorDraft(cellId, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  const place = draft.placement === "price" ? PRICE_GROUP : candidateGroup(row.candidate);

  return <>
    <aside ref={controls} className="ic-editor">
      <div className="ic-ed-head">
        <h3 className="text-l font-semibold">{kind.label}</h3>
        <span className="ui-badge" data-tone="accent">새 인스턴스 #{row.instanceCount + 1}</span>
        <span className="ic-place-badge">{place}</span>
        <span className="flex-1" />
        <p className="inline-flex items-center gap-1.5 text-s text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}</p>
      </div>
      <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} colorControl="popover" />
      {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
      {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
      {hasColor(draft.form) && <p className="text-xs text-text-3">테마 색은 테마를 바꾸면 함께 바뀝니다</p>}
    </aside>
    <CommandFooter mode="add">
      <button type="button" className="btn-primary disabled:opacity-50" disabled={!valid} onClick={() => commit(onCommitted)}>
        {primaryLabel(false, draft.form.kind, check.spec)}
      </button>
    </CommandFooter>
  </>;
}
