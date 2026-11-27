import { useEffect, useId, useRef, useState } from "react";
import { KINDS, specName } from "../../chart/indicators/kinds";
import type { IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { symbolSub } from "../../lib/symbol";
import { chartWindows, useLayoutStore } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type ChartPanelMode, type IndicatorCommandMode } from "../../stores/selection";
import { ChartSettingsSections } from "../chart-settings/ChartSettingsDialog";
import { CloseIcon, EyeIcon, SearchIcon, SlidersIcon } from "../icons";
import { IndicatorSettingsForm } from "../indicator-dialog/IndicatorSettingsForm";
import { useLiveIndicatorDraft } from "../indicator-dialog/liveDraft";
import { isMaConfig, MaGroupEditor } from "../indicator-dialog/MaGroupEditor";
import { removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { EmptyState } from "../overlay/State";
import { CompareSection } from "./CompareSection";
import { ADD_CATEGORIES, type AddCategory, groupDialogRows, MA_GROUP_KEY } from "./model";
import { useIndicatorCommand } from "./useIndicatorCommand";

export const CHART_DOCK_MIN_WIDTH = 640;

function DockDetailEditor({ cellId, config, onBack }: { cellId: WindowId; config: IndicatorConfig; onBack(): void }) {
  const { draft, setDraft, check, color } = useLiveIndicatorDraft(cellId, config);
  const shown = useLayoutStore((s) => chartWindows(s.layout).find((c) => c.id === cellId)?.chartSettings.indicators.find((i) => i.id === config.id)?.visible ?? true);
  return (
    <div className="cd-detail">
      <div className="cd-detail-head">
        <button type="button" className="cd-back-btn" onClick={onBack}>← 지표 목록</button>
        <button type="button" className="icon-btn" aria-label={shown ? "지표 숨기기" : "지표 보이기"} aria-pressed={!shown} onClick={() => useLayoutStore.getState().updateIndicator(cellId, config.id, { visible: !shown })}>
          <EyeIcon size={15} />
        </button>
        <button type="button" className="icon-btn text-danger" aria-label={`${specName(config.spec)} 지우기`} onClick={() => { removeIndicatorWithUndo(cellId, config); onBack(); }}>
          <CloseIcon size={15} />
        </button>
      </div>
      <h3 className="text-m font-semibold">{KINDS[config.spec.kind].label}</h3>
      <div className="flex flex-col gap-3">
        <IndicatorSettingsForm draft={draft} color={color} errors={check.errors} onChange={setDraft} foldColors />
      </div>
    </div>
  );
}

function DockMaGroupDetail({ cellId, onBack }: { cellId: WindowId; onBack(): void }) {
  const maCount = useLayoutStore((s) => chartWindows(s.layout).find((c) => c.id === cellId)?.chartSettings.indicators.filter(isMaConfig).length ?? 0);
  return (
    <div className="cd-detail">
      <div className="cd-detail-head">
        <button type="button" className="cd-back-btn" onClick={onBack}>← 지표 목록</button>
      </div>
      <h3 className="text-m font-semibold">이동평균선 ({maCount})</h3>
      <MaGroupEditor cellId={cellId} />
    </div>
  );
}

export function ChartRightDock({ cellId, hostRef }: { cellId: WindowId; hostRef: React.RefObject<HTMLElement | null> }) {
  const dock = useSelectionStore((s) => s.chartDock);
  const active = dock?.cellId === cellId ? dock : null;
  const [category, setCategory] = useState<AddCategory>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detailId;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  useEffect(() => {
    if (!active) return;
    setDetailId(active.indicatorId);
  }, [active?.cellId, active?.mode, active?.indicatorId]);

  useEffect(() => {
    if (!active) return;
    const el = hostRef.current;
    if (!el) return;
    const checkWidth = () => {
      if (el.clientWidth > 0 && el.clientWidth < CHART_DOCK_MIN_WIDTH) {
        const sel = useSelectionStore.getState();
        const fallbackId = detailIdRef.current === MA_GROUP_KEY ? null : detailIdRef.current;
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

  return <ChartRightDockBody cellId={cellId} mode={active.mode} category={category} setCategory={setCategory} detailId={detailId} setDetailId={setDetailId} inputRef={inputRef} ids={ids} />;
}

function ChartRightDockBody({ cellId, mode, category, setCategory, detailId, setDetailId, inputRef, ids }: {
  cellId: WindowId;
  mode: ChartPanelMode;
  category: AddCategory;
  setCategory: (c: AddCategory) => void;
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  ids: string;
}) {
  const cmdMode: IndicatorCommandMode = mode === "settings" ? "current" : mode;
  const command = useIndicatorCommand(cellId, cmdMode, detailId === MA_GROUP_KEY ? null : detailId);
  const { cell, input, rows: rawRows, compareButton } = command;

  useEffect(() => {
    if (mode !== "settings") command.show(mode);
  }, [mode]);

  const hasQuery = input.trim() !== "";
  const rows = groupDialogRows(rawRows, command.mode, category, hasQuery);
  const isMaDetail = detailId === MA_GROUP_KEY;
  const detailConfig = detailId && !isMaDetail ? cell.chartSettings.indicators.find((i) => i.id === detailId) ?? null : null;
  const showingDetail = isMaDetail || detailConfig !== null;
  const section = mode === "settings" ? "settings" : mode === "compare" ? "compare" : "indicators";

  const switchSection = (next: "indicators" | "compare" | "settings") => {
    setDetailId(null);
    const nextMode: ChartPanelMode = next === "indicators" ? defaultIndicatorMode(cellId) : next;
    useSelectionStore.getState().openChartDock(cellId, nextMode, null);
    if (nextMode !== "settings") command.show(nextMode);
  };

  return (
    <aside data-chart-control="" aria-label="차트 우측 설정 패널" className="cd-drawer" onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (showingDetail) setDetailId(null);
        else useSelectionStore.getState().closeChartDock();
      }
    }}>
      <header className="cd-head">
        <div role="group" aria-label="차트 설정 영역" className="ic-section-seg">
          <button type="button" aria-pressed={section === "indicators"} onClick={() => switchSection("indicators")}>지표</button>
          <button type="button" aria-pressed={section === "compare"} onClick={() => switchSection("compare")}>비교</button>
          <button type="button" aria-pressed={section === "settings"} onClick={() => switchSection("settings")}>설정</button>
        </div>
        <button type="button" className="cd-mode-btn" aria-label="가운데 모달로 전환" onClick={() => useSelectionStore.getState().openIndicatorDialog(cellId, mode, isMaDetail ? null : detailId)}>모달</button>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={() => useSelectionStore.getState().closeChartDock()}><CloseIcon size={15} /></button>
      </header>

      {section === "settings" ? (
        <div className="cd-body">
          <ChartSettingsSections cellId={cellId} compact />
        </div>
      ) : (
        <div className="cd-slide-viewport">
          <div className="cd-slide-track" data-detail={showingDetail ? "true" : undefined}>
            <div className="cd-slide-page">
              <label className="ic-search cd-search">
                <SearchIcon size={14} />
                <input ref={inputRef} type="search" aria-label="지표·비교 찾기" value={input} autoComplete="off" spellCheck={false}
                  placeholder={section === "compare" ? "종목 이름·코드" : command.mode === "current" ? "띄운 지표 검색" : "추가할 지표 검색"}
                  onChange={(e) => command.type(e.target.value)} />
              </label>

              {section === "indicators" && (
                <div className="cd-subtabs" role="tablist" aria-label="지표 보기">
                  <button type="button" role="tab" aria-selected={command.mode === "current"} onClick={() => command.show("current")}>적용됨 ({cell.chartSettings.indicators.length})</button>
                  <button type="button" role="tab" aria-selected={command.mode === "add"} onClick={() => command.show("add")}>지표 추가</button>
                </div>
              )}

              {section === "indicators" && command.mode === "add" && !hasQuery && (
                <div role="group" aria-label="지표 분류" className="ic-cats">
                  {ADD_CATEGORIES.map((item) => (
                    <button key={item.id} type="button" className="ic-cat" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>
                  ))}
                </div>
              )}

              {section === "compare" && <CompareSection cellId={cellId} button={compareButton} className="cd-compare-top" />}

              <ul id={`${ids}-list`} className="cd-list">
                {rows.map((row) => {
                  if (row.kind === "current") {
                    return (
                      <li key={row.key} className="cd-row" data-hidden={!row.config.visible || undefined}>
                        <button type="button" className="cd-row-main" onClick={() => setDetailId(row.config.id)}>
                          <span className="ic-row-title">{KINDS[row.config.spec.kind].label}</span>
                          <span className="ic-row-sub">{specName(row.config.spec)}</span>
                        </button>
                        <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} 세부 설정`} onClick={() => setDetailId(row.config.id)}><SlidersIcon size={13} /></button>
                        <button type="button" className="icon-btn size-6" aria-label={`${specName(row.config.spec)} 지우기`} onClick={() => removeIndicatorWithUndo(cellId, row.config)}><CloseIcon size={13} /></button>
                      </li>
                    );
                  }
                  if (row.kind === "maGroup") {
                    return (
                      <li key={row.key} className="cd-row">
                        <button type="button" className="cd-row-main" onClick={() => setDetailId(MA_GROUP_KEY)}>
                          <span className="ic-row-title">이동평균선 ({row.lines.length})</span>
                        </button>
                        <button type="button" className="icon-btn size-6" aria-label="이동평균선 세부 설정" onClick={() => setDetailId(MA_GROUP_KEY)}><SlidersIcon size={13} /></button>
                      </li>
                    );
                  }
                  if (row.kind === "candidate") {
                    return (
                      <li key={row.key} className="cd-row">
                        <button type="button" className="cd-row-main" onClick={() => useLayoutStore.getState().addIndicator(cellId, KINDS[row.candidate.kind].defaults, { colors: [], width: 1 })}>
                          <span className="ic-row-title">{row.candidate.label}</span>
                        </button>
                      </li>
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
                  <li><EmptyState title="항목이 없습니다" action="지표 추가" onAction={() => command.show("add")}>검색어를 입력하거나 지표를 추가해 보세요.</EmptyState></li>
                )}
              </ul>
            </div>
            <div className="cd-slide-page">
              {isMaDetail && <DockMaGroupDetail cellId={cellId} onBack={() => setDetailId(null)} />}
              {detailConfig && <DockDetailEditor key={detailConfig.id} cellId={cellId} config={detailConfig} onBack={() => setDetailId(null)} />}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
