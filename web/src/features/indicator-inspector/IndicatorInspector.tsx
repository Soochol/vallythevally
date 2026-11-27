import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { colorLine, indicatorCssColor, KINDS, shownColor, specName, type IndicatorKind } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore } from "../../stores/selection";
import { ChevronIcon, CloseIcon, EyeIcon, SearchIcon } from "../icons";
import { CompareSection } from "../indicator-command/CompareSection";
import {
  commandKey,
  currentKey,
  indicatorPeriodBadge,
  selectedTreeRow,
  treeChildLabel,
  unifiedIndicatorRows,
  type IndicatorCommandMode,
  type TreeCandidateRow,
  type TreeCurrentRow,
  type TreeDialogRow,
} from "../indicator-command/model";
import { useIndicatorCommand, useIndicatorDraft, type EditorAction } from "../indicator-command/useIndicatorCommand";
import { addButton, stepIndex } from "../indicator-dialog/compareForm";
import { primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { removeIndicatorWithUndo } from "./removalUndo";

export function IndicatorInspector() {
  const cellId = useSelectionStore((s) => s.activeCell);
  return <InspectorBody key={cellId} cellId={cellId} />;
}

const AUTO_OPEN = "auto";

const rowName = (row: TreeDialogRow) =>
  row.kind === "current" ? specName(row.config.spec) : row.kind === "candidate" ? row.candidate.label : row.info.name;

function InspectorBody({ cellId }: { cellId: WindowId }) {
  const command = useIndicatorCommand(cellId, defaultIndicatorMode(cellId));
  const { cell, mode, input, chosen, rows: rawRows, symbols, search, editor } = command;
  const [opened, setOpened] = useState<string | null>(null);
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<IndicatorKind>>(() => new Set());
  const request = useSelectionStore((s) => s.inspector);
  const inputRef = useRef<HTMLInputElement>(null);
  const revertRef = useRef<() => void>(null);
  const ids = useId();
  const hasQuery = input.trim() !== "";
  const isCompare = mode === "compare";
  const rows: TreeDialogRow[] = isCompare
    ? rawRows.filter((row): row is Extract<typeof row, { kind: "symbol" }> => row.kind === "symbol")
    : unifiedIndicatorRows(cell.chartSettings, input, collapsedKinds);
  const selected = selectedTreeRow(rows, chosen, false);
  const open = selected && (opened === AUTO_OPEN || opened === selected.key) ? selected : null;
  const picked = open?.kind === "symbol" && open.selectable ? open.info : null;
  const compareButton = addButton(cell.chartSettings, picked, cell.symbol);
  const rowId = (row: TreeDialogRow) => `${ids}-${row.key}`;

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
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
        if (open?.kind === "current" && open.config.spec.kind === kind) setOpened(null);
      }
      return next;
    });
  };

  useEffect(() => {
    const taken = request && useSelectionStore.getState().takeInspectorRequest();
    if (!taken) return;
    command.show(taken.mode, taken.indicatorId);
    if (taken.indicatorId !== null) {
      const target = cell.chartSettings.indicators.find((item) => item.id === taken.indicatorId);
      if (target) expandKind(target.spec.kind);
      setOpened(currentKey(taken.indicatorId));
    } else {
      setOpened(null);
    }
    inputRef.current?.focus();
  }, [request]);

  useEffect(() => {
    if (open) document.getElementById(rowId(open))?.scrollIntoView({ block: "nearest" });
  }, [open?.key]);

  const show = (value: IndicatorCommandMode) => { command.show(value); setOpened(null); };
  const toggle = (row: TreeDialogRow) => {
    if (open?.key === row.key && row.kind !== "symbol") return setOpened(null);
    if (row.kind === "symbol" && !row.selectable) return;
    command.selectKey(row.key);
    setOpened(row.key);
  };
  const collapse = () => { setOpened(null); inputRef.current?.focus(); };
  const refocus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
  const afterAdd = (kind: IndicatorKind, createdId?: string, focusSearch = false) => {
    expandKind(kind);
    if (createdId) {
      command.selectKey(currentKey(createdId));
      setOpened(currentKey(createdId));
    }
    if (focusSearch) refocus();
  };
  const submit = (fromSearch = false) => {
    if (!open) return;
    if (open.kind === "current") return collapse();
    if (open.kind === "symbol") {
      if (open.selectable && command.addCompareSymbol(open.info)) refocus();
      return;
    }
    const targetKind = open.candidate.kind;
    editor.current?.commit((createdId) => afterAdd(targetKind, createdId, fromSearch));
  };
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (commandKey(event.nativeEvent).kind === "submit" && event.target instanceof HTMLInputElement) {
      if (open?.kind === "current" && event.target !== inputRef.current) return;
      event.preventDefault();
      submit(event.target === inputRef.current);
      return;
    }
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    if (open.kind === "current") revertRef.current?.();
    collapse();
  };

  return <section data-chart-control="" aria-labelledby={`${ids}-title`} className="flex min-h-0 flex-1 flex-col" onKeyDown={keys}>
    <header className="ii-head">
      <h2 id={`${ids}-title`} className="text-m font-semibold">지표</h2>
      <div role="group" aria-label="지표 창 영역" className="ic-section-seg">
        <button type="button" aria-pressed={!isCompare} onClick={() => { show(defaultIndicatorMode(cellId)); inputRef.current?.focus(); }}>지표</button>
        <button type="button" aria-pressed={isCompare} onClick={() => { show("compare"); inputRef.current?.focus(); }}>비교</button>
      </div>
    </header>
    <div className="ii-search-bar">
      <label className="ic-search cd-search">
        <SearchIcon size={14} />
        <input ref={inputRef} type="search" aria-label="지표·비교 찾기" value={input} autoComplete="off" spellCheck={false}
          placeholder={isCompare ? "종목 이름·코드" : "지표 검색 (예: 이평 20, rsi 14)"}
          onChange={(event) => { command.type(event.target.value); setOpened(event.target.value.trim() === "" ? null : AUTO_OPEN); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const action = commandKey(event.nativeEvent);
            if (action.kind !== "move") return;
            event.preventDefault();
            const next = rows[stepIndex(open ? rows.indexOf(open) : -1, action.step, rows.length)];
            if (next) { command.selectKey(next.key); setOpened(next.kind !== "symbol" || next.selectable ? next.key : null); }
          }} />
        {input !== "" && (
          <button type="button" className="ic-search-clear" aria-label="검색어 지우기" onClick={() => { command.type(""); setOpened(null); inputRef.current?.focus(); }}>
            <CloseIcon size={12} />
          </button>
        )}
      </label>
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-2 pb-2 pt-1">
      <ul aria-label={isCompare ? "비교 후보" : "지표 목록"} className="flex flex-col gap-0.5">
        {rows.map((row, i) => {
          const isOpen = open?.key === row.key;
          const showGroup = row.group !== rows[i - 1]?.group;
          return <Fragment key={row.key}>
            {showGroup && <li role="presentation" className="ic-group"><span>{row.group}</span></li>}
            {row.kind === "symbol" ? (
              <li id={rowId(row)} className={isOpen ? "ii-item-open" : undefined}>
                <button type="button" aria-pressed={isOpen} disabled={!row.selectable} onClick={() => toggle(row)}
                  className="flex h-9 w-full items-center gap-2 rounded-l px-2 text-left text-s hover:bg-raised disabled:opacity-50 aria-pressed:bg-accent-soft">
                  <span className="min-w-0 flex-1 truncate">{row.info.name}</span><span className="text-xs text-text-3">{symbolSub(row.info.code, row.info)}</span>
                </button>
              </li>
            ) : row.kind === "candidate" ? (
              <li id={rowId(row)} className={isOpen ? "ii-item-open" : undefined}>
                <ParentRow
                  row={row}
                  hasQuery={hasQuery}
                  collapsed={!hasQuery && collapsedKinds.has(row.candidate.kind)}
                  open={isOpen}
                  onToggle={() => toggle(row)}
                  onToggleCollapse={() => toggleKind(row.candidate.kind)}
                >
                  {isOpen && (
                    <AddEditor
                      key={`${row.key}:${row.instanceCount}`}
                      cellId={cellId}
                      row={row}
                      actionRef={editor}
                      onAdded={(createdId) => afterAdd(row.candidate.kind, createdId, false)}
                    />
                  )}
                </ParentRow>
              </li>
            ) : (
              <li id={rowId(row)} className={`ii-child-wrap ${isOpen ? "ii-item-open" : ""}`}>
                <ChildRow cellId={cellId} row={row} open={isOpen} onToggle={() => toggle(row)}>
                  {isOpen && <LiveEditor key={row.key} cellId={cellId} config={row.config} instanceIndex={row.index} revertRef={revertRef} />}
                </ChildRow>
              </li>
            )}
          </Fragment>;
        })}
        {rows.length === 0 && !search.isFetching && !search.isError && <li role="presentation">
          <EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); setOpened(null); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState>
        </li>}
        {isCompare && !symbols.selectable && search.isFetching && <li role="presentation"><Skeleton label="비교 종목 찾는 중" /></li>}
        {isCompare && search.isError && <li role="presentation"><ErrorState message="종목을 찾지 못했습니다. 다시 시도해 보세요." retry={() => void search.refetch()} /></li>}
      </ul>
      {isCompare && <CompareSection cellId={cellId} button={compareButton} add={{ enabled: picked !== null, run: () => submit(true) }} className="mt-2 flex flex-col gap-3 border-t border-line px-2 pt-3" />}
    </div>
    <p className="sr-only" aria-live="polite">{open ? `${rowName(open)} ${open.kind === "symbol" ? "선택" : "펼침"}` : ""}</p>
    <footer className="flex-none border-t border-line px-4 py-2.5 text-xs text-text-3">바로 반영 · Esc로 되돌리고 닫기</footer>
  </section>;
}

function ParentRow({ row, hasQuery, collapsed, open, onToggle, onToggleCollapse, children }: {
  row: TreeCandidateRow;
  hasQuery: boolean;
  collapsed: boolean;
  open: boolean;
  onToggle(): void;
  onToggleCollapse(): void;
  children: ReactNode;
}) {
  const rule = indicatorPeriodBadge(row.candidate.kind);
  const hasChildren = row.instanceCount > 0;
  const kindLabel = KINDS[row.candidate.kind].label;
  return <>
    <div className="ic-row ic-tree-parent" data-has-children={hasChildren || undefined} data-open={open || undefined} onClick={onToggle}>
      {hasChildren ? (
        <button type="button" className="ic-tree-chev" aria-label={collapsed ? `${kindLabel} 인스턴스 펼치기` : `${kindLabel} 인스턴스 접기`} aria-expanded={!collapsed} data-collapsed={collapsed || undefined} onClick={(event) => { event.stopPropagation(); onToggleCollapse(); }}>
          <ChevronIcon size={12} />
        </button>
      ) : (
        <span aria-hidden="true" className="ic-tree-dot-spacer"><i /></span>
      )}
      <button type="button" aria-expanded={open} aria-label={`${row.candidate.label} 추가 후보`} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="ic-row-text">
        <span className="ic-row-title">
          <span className="ic-row-title-label">{hasQuery ? row.candidate.label : kindLabel}</span>
          {rule && <span className="ui-badge" data-tone="warning">{rule}</span>}
        </span>
      </button>
      <span aria-hidden="true" className="ic-tree-add-cue">+ 추가</span>
      {hasChildren && <span className="ui-badge" data-tone="accent">{row.instanceCount}</span>}
    </div>
    {children}
  </>;
}

function ChildRow({ cellId, row, open, onToggle, children }: {
  cellId: WindowId;
  row: TreeCurrentRow;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const full = specName(row.config.spec);
  const hasDot = colorLine(row.config.spec) !== null;
  return <>
    <div className="ic-row ic-tree-child" data-hidden={!row.config.visible || undefined} data-open={open || undefined} onClick={onToggle}>
      <span aria-hidden="true" className="ic-tree-idx">#{row.index}</span>
      <span aria-hidden="true" className="ic-color-dot" style={{ background: hasDot ? indicatorCssColor(shownColor(row.config.spec, row.config.style.colors)) : "var(--text-3)" }} />
      <button type="button" aria-expanded={open} aria-label={`${full} 설정`} title={full} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="ic-row-text">
        <span className="ic-tree-child-label">{treeChildLabel(row.config.spec)}</span>
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
    </div>
    {children}
  </>;
}

function LiveEditor({ cellId, config, instanceIndex, revertRef }: { cellId: WindowId; config: IndicatorConfig; instanceIndex: number; revertRef: Ref<() => void> }) {
  const [initial] = useState(config);
  const { draft, setDraft, validator, check, color, revert } = useLiveIndicatorDraft(cellId, initial);
  const kind = KINDS[draft.form.kind];
  useImperativeHandle(revertRef, () => revert);
  return <div role="group" aria-label={`${specName(initial.spec)} 설정`} className="ii-editor">
    <div className="ic-ed-head">
      <span className="ui-badge" data-tone="accent">#{instanceIndex}</span>
      <span className="flex-1" />
      <p className="inline-flex items-center gap-1.5 text-xs text-accent">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
        {check.ok ? "자동 저장됨" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}
      </p>
    </div>
    <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} lineSample={false} />
    {check.errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
    {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
  </div>;
}

function AddEditor({ cellId, row, actionRef, onAdded }: { cellId: WindowId; row: TreeCandidateRow; actionRef: Ref<EditorAction>; onAdded(createdId?: string): void }) {
  const root = useRef<HTMLDivElement>(null);
  const focus = () => root.current?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")?.focus();
  const { draft, setDraft, validator, check, errors, valid, color, commit } = useIndicatorDraft(cellId, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  return <div ref={root} role="group" aria-label={`${kind.label} 추가 설정`} className="ii-editor">
    <div className="ic-ed-head">
      <span className="ui-badge" data-tone="accent">새 인스턴스 #{row.instanceCount + 1}</span>
      <span className="flex-1" />
      <p className="inline-flex items-center gap-1.5 text-xs text-accent">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
        {valid ? "차트에 미리보기 중" : validator === "loading" ? "미리보기 준비 중" : "설정을 확인하세요"}
      </p>
    </div>
    <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} lineSample={false} />
    {errors.filter((error) => !kind.fields.some((field) => field.key === error.field)).map((error, i) => <p key={i} className="text-s text-danger">{error.message}</p>)}
    {validator === "failed" && <p role="alert" className="text-s text-danger">지표 설정 검사기를 불러오지 못했습니다. 새로고침해 보세요.</p>}
    <button type="button" className="btn-primary self-end disabled:opacity-50" disabled={!valid} onClick={() => commit(onAdded)}>{primaryLabel(false, draft.form.kind, check.spec)}</button>
  </div>;
}
