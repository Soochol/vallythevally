import { Fragment, useEffect, useId, useRef, useState } from "react";
import { colorLine, indicatorCssColor, KINDS, shownColor, specName, type IndicatorKind } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartPanelMode, type IndicatorCommandMode } from "../../stores/selection";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { ChevronIcon, CloseIcon, EyeIcon, SearchIcon } from "../icons";
import { primaryLabel } from "../indicator-dialog/indicatorForm";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { EmptyState } from "../overlay/State";
import { CompareSection } from "./CompareSection";
import { indicatorPeriodBadge, treeChildLabel, unifiedIndicatorRows, type TreeCandidateRow, type TreeDialogRow } from "./model";
import { useIndicatorCommand, useIndicatorDraft, type EditorAction } from "./useIndicatorCommand";

export const CHART_DOCK_MIN_WIDTH = 640;

type DockDetailTarget =
  | { kind: "current"; id: string }
  | { kind: "candidate"; row: TreeCandidateRow };

function DockDetailEditor({ cellId, config, instanceIndex, onBack }: { cellId: WindowId; config: IndicatorConfig; instanceIndex: number; onBack(): void }) {
  const { draft, setDraft, check, color } = useLiveIndicatorDraft(cellId, config);
  const shown = useLayoutStore((s) => chartWindows(s.layout).find((c) => c.id === cellId)?.chartSettings.indicators.find((i) => i.id === config.id)?.visible ?? true);
  return (
    <div className="cd-detail">
      <div className="cd-detail-head">
        <button type="button" className="cd-back-btn" onClick={onBack}>← 지표 목록</button>
        <button type="button" className="icon-btn" aria-label={shown ? "지표 숨기기" : "지표 보이기"} aria-pressed={!shown} onClick={() => useLayoutStore.getState().updateIndicator(cellId, config.id, { visible: !shown })}>
          <EyeIcon size={15} off={!shown} />
        </button>
        <button type="button" className="icon-btn text-danger" aria-label={`${specName(config.spec)} 지우기`} onClick={() => { removeIndicatorWithUndo(cellId, config); onBack(); }}>
          <CloseIcon size={15} />
        </button>
      </div>
      <div className="ic-ed-head">
        <h3 className="text-m font-semibold">{KINDS[config.spec.kind].label}</h3>
        <span className="ui-badge" data-tone="accent">#{instanceIndex}</span>
      </div>
      <div className="flex flex-col gap-3">
        <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} foldColors />
      </div>
    </div>
  );
}

function DockCandidateEditor({ cellId, row, onBack, onCreated }: { cellId: WindowId; row: TreeCandidateRow; onBack(): void; onCreated(id: string): void }) {
  const actionRef = useRef<EditorAction | null>(null);
  const focus = () => {};
  const { draft, setDraft, check, errors, valid, color, commit } = useIndicatorDraft(cellId, row, actionRef, focus);
  const kind = KINDS[draft.form.kind];
  return (
    <div className="cd-detail">
      <div className="cd-detail-head">
        <button type="button" className="cd-back-btn" onClick={onBack}>← 지표 목록</button>
      </div>
      <div className="ic-ed-head">
        <h3 className="text-m font-semibold">{kind.label}</h3>
        <span className="ui-badge" data-tone="accent">새 인스턴스 #{row.instanceCount + 1}</span>
      </div>
      <div className="flex flex-col gap-3">
        <IndicatorSettingsForm draft={draft} color={color} errors={errors} onChange={setDraft} foldColors />
      </div>
      <button type="button" className="btn-primary self-end disabled:opacity-50" disabled={!valid} onClick={() => commit((createdId) => { if (createdId) onCreated(createdId); })}>
        {primaryLabel(false, draft.form.kind, check.spec)}
      </button>
    </div>
  );
}

export function ChartRightDock({ cellId, hostRef }: { cellId: WindowId; hostRef: React.RefObject<HTMLElement | null> }) {
  const dock = useSelectionStore((s) => s.chartDock);
  const active = dock?.cellId === cellId ? dock : null;
  const [detailTarget, setDetailTarget] = useState<DockDetailTarget | null>(null);
  const detailRef = useRef<DockDetailTarget | null>(null);
  detailRef.current = detailTarget;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  useEffect(() => {
    if (!active) return;
    setDetailTarget(active.indicatorId ? { kind: "current", id: active.indicatorId } : null);
  }, [active?.cellId, active?.mode, active?.indicatorId]);

  useEffect(() => {
    if (!active) return;
    const el = hostRef.current;
    if (!el) return;
    const checkWidth = () => {
      if (el.clientWidth > 0 && el.clientWidth < CHART_DOCK_MIN_WIDTH) {
        const sel = useSelectionStore.getState();
        const fallbackId = detailRef.current?.kind === "current" ? detailRef.current.id : null;
        sel.openIndicatorDialog(cellId, active.mode, fallbackId);
        sel.showToast("차트 폭이 640px 미만이라 가운데 창으로 열었습니다");
      }
    };
    checkWidth();
    const observer = new ResizeObserver(checkWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active?.cellId, active?.mode, cellId, hostRef]);

  if (!active) return null;

  return <ChartRightDockBody cellId={cellId} mode={active.mode} detailTarget={detailTarget} setDetailTarget={setDetailTarget} inputRef={inputRef} ids={ids} />;
}

function ChartRightDockBody({ cellId, mode, detailTarget, setDetailTarget, inputRef, ids }: {
  cellId: WindowId;
  mode: ChartPanelMode;
  detailTarget: DockDetailTarget | null;
  setDetailTarget: (target: DockDetailTarget | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  ids: string;
}) {
  const cmdMode: IndicatorCommandMode = mode === "settings" ? "current" : mode;
  const command = useIndicatorCommand(cellId, cmdMode, detailTarget?.kind === "current" ? detailTarget.id : null);
  const { cell, input, rows: rawRows, compareButton } = command;
  const [collapsedKinds, setCollapsedKinds] = useState<ReadonlySet<IndicatorKind>>(() => new Set());

  useEffect(() => {
    if (mode !== "settings") command.show(mode);
  }, [mode]);

  const hasQuery = input.trim() !== "";
  const section = mode === "settings" ? "settings" : mode === "compare" ? "compare" : "indicators";
  const rows: TreeDialogRow[] = section === "compare"
    ? rawRows.filter((row): row is Extract<typeof row, { kind: "symbol" }> => row.kind === "symbol")
    : unifiedIndicatorRows(cell.chartSettings, input, collapsedKinds);

  const detailConfig = detailTarget?.kind === "current"
    ? cell.chartSettings.indicators.find((i) => i.id === detailTarget.id) ?? null
    : null;
  const detailInstanceIndex = detailConfig
    ? cell.chartSettings.indicators.filter((i) => i.spec.kind === detailConfig.spec.kind).findIndex((i) => i.id === detailConfig.id) + 1
    : 1;
  const detailCandidate = detailTarget?.kind === "candidate" ? detailTarget.row : null;
  const showingDetail = detailConfig !== null || detailCandidate !== null;

  const toggleKind = (kind: IndicatorKind) => {
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const expandKind = (kind: IndicatorKind) => {
    setCollapsedKinds((prev) => {
      if (!prev.has(kind)) return prev;
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
  };

  const switchSection = (next: "indicators" | "settings" | "compare") => {
    setDetailTarget(null);
    const nextMode: ChartPanelMode = next === "indicators" ? defaultIndicatorMode(cellId) : next;
    useSelectionStore.getState().openChartDock(cellId, nextMode, null);
    if (nextMode !== "settings") command.show(nextMode);
  };

  return (
    <aside data-chart-control="" aria-label="차트 우측 설정 패널" className="cd-drawer" onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (showingDetail) setDetailTarget(null);
        else useSelectionStore.getState().closeChartDock();
      }
    }}>
      <header className="cd-head">
        <div role="group" aria-label="차트 설정 영역" className="ic-section-seg">
          <button type="button" aria-pressed={section === "indicators"} onClick={() => switchSection("indicators")}>지표</button>
          <button type="button" aria-label="차트 설정" aria-pressed={section === "settings"} onClick={() => switchSection("settings")}>차트</button>
          <button type="button" aria-pressed={section === "compare"} onClick={() => switchSection("compare")}>비교</button>
        </div>
        <button type="button" className="cd-mode-btn" aria-label="가운데 모달로 전환" onClick={() => useSelectionStore.getState().openIndicatorDialog(cellId, mode, detailTarget?.kind === "current" ? detailTarget.id : null)}>모달</button>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={() => useSelectionStore.getState().closeChartDock()}><CloseIcon size={15} /></button>
      </header>

      {section === "settings" ? (
        <div className="cd-settings-body">
          <ChartSettingsSections cellId={cellId} compact />
        </div>
      ) : (
        <div className="cd-slide-viewport">
          <div className="cd-slide-track" data-detail={showingDetail ? "true" : undefined}>
            <div className="cd-slide-page">
              <label className="ic-search cd-search">
                <SearchIcon size={14} />
                <input ref={inputRef} type="search" aria-label="지표·비교 찾기" value={input} autoComplete="off" spellCheck={false}
                  placeholder={section === "compare" ? "종목 이름·코드" : "지표 검색 (예: 이평 20, rsi 14)"}
                  onChange={(e) => command.type(e.target.value)} />
              </label>

              {section === "compare" && <CompareSection cellId={cellId} button={compareButton} className="cd-compare-top" />}

              <ul id={`${ids}-list`} className="cd-list">
                {rows.map((row, i) => {
                  const showGroup = row.group !== rows[i - 1]?.group;
                  if (row.kind === "candidate") {
                    const rule = indicatorPeriodBadge(row.candidate.kind);
                    const hasChildren = row.instanceCount > 0;
                    const collapsed = !hasQuery && collapsedKinds.has(row.candidate.kind);
                    return (
                      <Fragment key={row.key}>
                        {showGroup && <li role="presentation" className="ic-group"><span>{row.group}</span></li>}
                        <li className="ic-row ic-tree-parent" data-has-children={hasChildren || undefined} onClick={() => setDetailTarget({ kind: "candidate", row })}>
                          {hasChildren ? (
                            <button type="button" className="ic-tree-chev" aria-label={collapsed ? `${KINDS[row.candidate.kind].label} 인스턴스 펼치기` : `${KINDS[row.candidate.kind].label} 인스턴스 접기`} aria-expanded={!collapsed} data-collapsed={collapsed || undefined} onClick={(e) => { e.stopPropagation(); toggleKind(row.candidate.kind); }}>
                              <ChevronIcon size={12} />
                            </button>
                          ) : (
                            <span aria-hidden="true" className="ic-tree-dot-spacer"><i /></span>
                          )}
                          <button type="button" className="ic-row-text" aria-label={`${row.candidate.label} 추가 후보`} onClick={(e) => { e.stopPropagation(); setDetailTarget({ kind: "candidate", row }); }}>
                            <span className="ic-row-title">
                              <span className="ic-row-title-label">{hasQuery ? row.candidate.label : KINDS[row.candidate.kind].label}</span>
                              {rule && <span className="ui-badge" data-tone="warning">{rule}</span>}
                            </span>
                          </button>
                          <span aria-hidden="true" className="ic-tree-add-cue">+ 추가</span>
                          {hasChildren && <span className="ui-badge" data-tone="accent">{row.instanceCount}</span>}
                        </li>
                      </Fragment>
                    );
                  }
                  if (row.kind === "current") {
                    const full = specName(row.config.spec);
                    const hasDot = colorLine(row.config.spec) !== null;
                    return (
                      <Fragment key={row.key}>
                        {showGroup && <li role="presentation" className="ic-group"><span>{row.group}</span></li>}
                        <li className="ic-row ic-tree-child" data-hidden={!row.config.visible || undefined} onClick={() => setDetailTarget({ kind: "current", id: row.config.id })}>
                          <span aria-hidden="true" className="ic-tree-idx">#{row.index}</span>
                          <span aria-hidden="true" className="ic-color-dot" style={{ background: hasDot ? indicatorCssColor(shownColor(row.config.spec, row.config.style.colors)) : "var(--text-3)" }} />
                          <button type="button" className="ic-row-text" aria-label={`${full} 설정`} title={full} onClick={(e) => { e.stopPropagation(); setDetailTarget({ kind: "current", id: row.config.id }); }}>
                            <span className="ic-tree-child-label">{treeChildLabel(row.config.spec)}</span>
                          </button>
                          <div className="ic-row-actions">
                            <button type="button" className="icon-btn size-6" aria-label={`${full} ${row.config.visible ? "숨기기" : "보이기"}`} onClick={(e) => { e.stopPropagation(); useLayoutStore.getState().updateIndicator(cellId, row.config.id, { visible: !row.config.visible }); }}><EyeIcon size={13} off={!row.config.visible} /></button>
                            <button type="button" className="icon-btn size-6" aria-label={`${full} 지우기`} onClick={(e) => { e.stopPropagation(); removeIndicatorWithUndo(cellId, row.config); }}><CloseIcon size={13} /></button>
                          </div>
                        </li>
                      </Fragment>
                    );
                  }
                  return (
                    <li key={row.key} className="cd-row">
                      <button type="button" className="cd-row-main" disabled={!row.selectable} onClick={() => row.selectable && command.addCompareSymbol(row.info)}>
                        <span className="ic-row-title">{row.info.name}</span>
                        <span className="ic-row-sub">{symbolSub(row.info.code, row.info)}</span>
                      </button>
                    </li>
                  );
                })}
                {rows.length === 0 && (
                  <li><EmptyState title="맞는 항목이 없습니다" action="입력 지우기" onAction={() => { command.type(""); inputRef.current?.focus(); }}>이름·약어·초성으로 찾아보세요.</EmptyState></li>
                )}
              </ul>
            </div>
            <div className="cd-slide-page">
              {detailConfig && <DockDetailEditor key={detailConfig.id} cellId={cellId} config={detailConfig} instanceIndex={detailInstanceIndex} onBack={() => setDetailTarget(null)} />}
              {detailCandidate && (
                <DockCandidateEditor
                  key={`${detailCandidate.key}:${detailCandidate.instanceCount}`}
                  cellId={cellId}
                  row={detailCandidate}
                  onBack={() => setDetailTarget(null)}
                  onCreated={(id) => { expandKind(detailCandidate.candidate.kind); setDetailTarget({ kind: "current", id }); }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
