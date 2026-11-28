import { useEffect, useMemo, useRef, useState } from "react";
import { useSymbolInfos } from "../../api/queries";
import { colorLine, indicatorCssColor, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { axisSlotLabel, nextIndicatorAxis, resolvePanelScales } from "../../chart/indicators/scales";
import type { ChartSettings, IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { ArrowIcon, ChevronIcon, CloseIcon, EyeIcon, MoreIcon, PlusIcon } from "../icons";
import { isMaConfig } from "../indicator-dialog/MaGroupEditor";
import { removeIndicatorsWithUndo, removeIndicatorWithUndo } from "../indicator-inspector/removalUndo";
import { treeChildLabel, type AddCategory } from "./model";

export type DockSelectionTarget =
  | { kind: "indicator"; id: string }
  | { kind: "maGroup" }
  | null;

const COMPARE_TOKENS = ["var(--cmp-1)", "var(--cmp-2)", "var(--cmp-3)"] as const;

export interface DockLayerListProps {
  cellId: WindowId;
  settings: ChartSettings;
  selectedTarget: DockSelectionTarget;
  isSnapped: boolean;
  onSelectTarget(target: DockSelectionTarget): void;
  onOpenQuickAdd(category: AddCategory): void;
  cleanupOpen: boolean;
  onCleanupOpenChange(open: boolean): void;
}

function compactParams(config: IndicatorConfig): string {
  const label = KINDS[config.spec.kind].label;
  const full = specName(config.spec);
  if (full === label) return "";
  return full.startsWith(label) ? full.slice(label.length).trim() : treeChildLabel(config.spec);
}

export function DockLayerList({
  cellId,
  settings,
  selectedTarget,
  isSnapped,
  onSelectTarget,
  onOpenQuickAdd,
  cleanupOpen,
  onCleanupOpenChange,
}: DockLayerListProps) {
  const [dangerRowId, setDangerRowId] = useState<string | null>(null);
  const [dangerPanelId, setDangerPanelId] = useState<string | null>(null);
  const cleanupRef = useRef<HTMLDivElement>(null);
  const compareInfos = useSymbolInfos(settings.compare);

  useEffect(() => {
    if (!cleanupOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (cleanupRef.current && event.target instanceof Node && !cleanupRef.current.contains(event.target)) {
        onCleanupOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [cleanupOpen, onCleanupOpenChange]);

  const maLines = useMemo(() => settings.indicators.filter(isMaConfig), [settings.indicators]);
  const priceNonMa = useMemo(
    () => settings.indicators.filter((item) => item.panel === "price" && !isMaConfig(item)),
    [settings.indicators],
  );
  const subPanels = useMemo(
    () =>
      settings.panels
        .map((panel, index) => ({
          panel,
          index,
          members: settings.indicators.filter((item) => item.panel === panel.id),
        }))
        .filter((entry) => entry.members.length > 0),
    [settings.panels, settings.indicators],
  );

  const hiddenIndicators = useMemo(
    () => settings.indicators.filter((item) => !item.visible),
    [settings.indicators],
  );
  const allSubPanelsCollapsed = subPanels.length > 0 && subPanels.every((entry) => entry.panel.collapsed);

  const isIndicatorSelected = (id: string) => selectedTarget?.kind === "indicator" && selectedTarget.id === id;
  const isMaGroupSelected = selectedTarget?.kind === "maGroup"
    || (selectedTarget?.kind === "indicator" && maLines.some((line) => line.id === selectedTarget.id));

  const toggleMaGroupVisibility = () => {
    const store = useLayoutStore.getState();
    const anyVisible = maLines.some((line) => line.visible);
    for (const line of maLines) {
      if (line.visible === anyVisible) {
        store.updateIndicator(cellId, line.id, { visible: !anyVisible });
      }
    }
  };

  const toggleAllSubPanels = () => {
    const store = useLayoutStore.getState();
    for (const entry of subPanels) {
      if (entry.panel.collapsed !== !allSubPanelsCollapsed) {
        store.togglePanel(cellId, entry.panel.id);
      }
    }
    onCleanupOpenChange(false);
  };

  const showAllHidden = () => {
    const store = useLayoutStore.getState();
    for (const item of hiddenIndicators) store.updateIndicator(cellId, item.id, { visible: true });
    onCleanupOpenChange(false);
  };

  const removeAllHidden = () => {
    if (selectedTarget?.kind === "indicator" && hiddenIndicators.some((item) => item.id === selectedTarget.id)) {
      onSelectTarget(null);
    }
    if (selectedTarget?.kind === "maGroup" && maLines.length > 0 && maLines.every((item) => !item.visible)) {
      onSelectTarget(null);
    }
    removeIndicatorsWithUndo(cellId, hiddenIndicators, `숨긴 지표 ${hiddenIndicators.length}개를 지웠습니다`);
    onCleanupOpenChange(false);
  };

  const toggleSelectIndicator = (id: string) => {
    onSelectTarget(isIndicatorSelected(id) ? null : { kind: "indicator", id });
  };

  const toggleSelectMaGroup = () => {
    onSelectTarget(isMaGroupSelected ? null : { kind: "maGroup" });
  };

  const priceLayerCount = (maLines.length > 0 ? 1 : 0) + priceNonMa.length + settings.compare.length;

  return (
    <div className="b3-layers-wrap">
      <div className="b3-layers-scroll">
        <section className="b3-panel-card" aria-label="가격 패널">
          <div className="b3-panel-head">
            <span className="b3-panel-title">가격 패널</span>
            <span className="b3-panel-count">{priceLayerCount}</span>
            <span className="flex-1" />
            <button
              type="button"
              className="b3-panel-act"
              aria-label="가격 지표 추가"
              title="가격 지표 추가"
              onClick={() => onOpenQuickAdd("price")}
            >
              <PlusIcon size={12} />
            </button>
          </div>

          <div className="b3-panel-body">
            <div className="b3-candle-row">
              <span aria-hidden="true" className="b3-candle-glyph" />
              <span className="b3-candle-label">캔들</span>
              <span className="b3-candle-meta">기준층</span>
              <button
                type="button"
                className="b3-layer-pill"
                aria-pressed={settings.candlesOnTop}
                aria-label={settings.candlesOnTop ? "캔들 지표 위에 그리기 켜짐" : "캔들 지표 아래에 그리기"}
                title="캔들과 지표 겹침 순서 전환"
                onClick={() => useLayoutStore.getState().setCandlesOnTop(cellId, !settings.candlesOnTop)}
              >
                {settings.candlesOnTop ? "지표 위" : "지표 아래"}
              </button>
            </div>

            {maLines.length > 0 && (
              <div
                className="b3-layer-row"
                data-selected={isMaGroupSelected || undefined}
                data-hidden={maLines.every((line) => !line.visible) || undefined}
                data-danger-hover={dangerRowId === "ma-group" || undefined}
                onClick={toggleSelectMaGroup}
              >
                {isMaGroupSelected && <span aria-hidden="true" className="b3-select-notch" />}
                <button
                  type="button"
                  className="b3-row-eye"
                  aria-label={maLines.some((line) => line.visible) ? "이동평균선 모두 숨기기" : "이동평균선 모두 보이기"}
                  aria-pressed={!maLines.some((line) => line.visible)}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMaGroupVisibility();
                  }}
                >
                  <EyeIcon size={13} off={!maLines.some((line) => line.visible)} />
                </button>
                <span aria-hidden="true" className="b3-ma-dots">
                  {maLines.slice(0, 4).map((line) => (
                    <i
                      key={line.id}
                      style={{
                        background: indicatorCssColor(shownColor(line.spec, line.style.colors)),
                        opacity: line.visible ? 1 : 0.3,
                      }}
                    />
                  ))}
                </span>
                <button
                  type="button"
                  className="b3-row-main"
                  aria-label="이동평균 묶음 설정"
                  aria-expanded={isMaGroupSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelectMaGroup();
                  }}
                >
                  <span className="b3-row-name">이동평균</span>
                  <span className="b3-row-params">
                    {maLines.map((line) => line.spec.period).join("·")}
                  </span>
                </button>
                <span className="b3-row-count">{maLines.filter((line) => line.visible).length}/{maLines.length}</span>
                <div className="b3-row-acts" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="b3-row-act b3-row-act-danger"
                    aria-label="이동평균선 모두 지우기"
                    title="이동평균선 모두 지우기"
                    onMouseEnter={() => setDangerRowId("ma-group")}
                    onMouseLeave={() => setDangerRowId(null)}
                    onClick={() => {
                      if (isMaGroupSelected) onSelectTarget(null);
                      setDangerRowId(null);
                      removeIndicatorsWithUndo(cellId, maLines, `이동평균선 ${maLines.length}개를 지웠습니다`);
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              </div>
            )}

            {priceNonMa.map((config) => {
              const selected = isIndicatorSelected(config.id);
              const full = specName(config.spec);
              const params = compactParams(config);
              const hasColorSwatch = colorLine(config.spec) !== null;
              const swatchCss = hasColorSwatch ? indicatorCssColor(shownColor(config.spec, config.style.colors)) : "var(--text-3)";
              return (
                <div
                  key={config.id}
                  className="b3-layer-row"
                  data-selected={selected || undefined}
                  data-hidden={!config.visible || undefined}
                  data-danger-hover={dangerRowId === config.id || undefined}
                  onClick={() => toggleSelectIndicator(config.id)}
                >
                  {selected && <span aria-hidden="true" className="b3-select-notch" />}
                  <button
                    type="button"
                    className="b3-row-eye"
                    aria-label={`${full} ${config.visible ? "숨기기" : "보이기"}`}
                    aria-pressed={!config.visible}
                    onClick={(e) => {
                      e.stopPropagation();
                      useLayoutStore.getState().updateIndicator(cellId, config.id, { visible: !config.visible });
                    }}
                  >
                    <EyeIcon size={13} off={!config.visible} />
                  </button>
                  <span aria-hidden="true" className="b3-swatch-bar" style={{ background: swatchCss, height: Math.min(4, Math.max(2, config.style.width)) }} />
                  <button
                    type="button"
                    className="b3-row-main"
                    aria-label={`${full} 설정`}
                    aria-expanded={selected}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelectIndicator(config.id);
                    }}
                  >
                    <span className="b3-row-name">{KINDS[config.spec.kind].label}</span>
                    {params && <span className="b3-row-params">{params}</span>}
                  </button>
                  <div className="b3-row-acts" onClick={(e) => e.stopPropagation()}>
                    {config.spec.kind === "volume" && (
                      <button
                        type="button"
                        className="b3-row-act"
                        aria-label="거래량 아래 패널로 분리"
                        title="아래 패널로 분리"
                        onClick={() => useLayoutStore.getState().setIndicatorPlacement(cellId, config.id, "panel")}
                      >
                        <ArrowIcon size={11} dir="down" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="b3-row-act b3-row-act-danger"
                      aria-label={`${full} 지우기`}
                      title="지우기"
                      onMouseEnter={() => setDangerRowId(config.id)}
                      onMouseLeave={() => setDangerRowId(null)}
                      onClick={() => {
                        if (selected) onSelectTarget(null);
                        setDangerRowId(null);
                        removeIndicatorWithUndo(cellId, config);
                      }}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                </div>
              );
            })}

            {settings.compare.map((code, index) => {
              const info = compareInfos.find((item) => item.code === code);
              const name = info?.name ?? code;
              return (
                <div key={code} className="b3-compare-row">
                  <span aria-hidden="true" className="b3-swatch-bar" style={{ background: COMPARE_TOKENS[index % COMPARE_TOKENS.length] }} />
                  <span className="b3-row-name">{name}</span>
                  <span className="ui-badge" data-tone="accent">비교 %</span>
                  <button
                    type="button"
                    className="b3-row-act b3-row-act-danger"
                    aria-label={`${name} 비교 지우기`}
                    title="비교 종목 지우기"
                    onClick={() => useLayoutStore.getState().removeCompare(cellId, code)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {subPanels.map(({ panel, index, members }) => {
          const scales = members.length > 1 ? resolvePanelScales(settings.indicators, panel.id) : null;
          const panelTitle = `아래 패널 ${index + 1}`;
          return (
            <section
              key={panel.id}
              className="b3-panel-card"
              data-collapsed={panel.collapsed || undefined}
              data-danger-hover={dangerPanelId === panel.id || undefined}
              aria-label={panelTitle}
            >
              <div className="b3-panel-head">
                <button
                  type="button"
                  className="b3-panel-chev"
                  aria-label={panel.collapsed ? `${panelTitle} 펼치기` : `${panelTitle} 접기`}
                  aria-expanded={!panel.collapsed}
                  data-collapsed={panel.collapsed || undefined}
                  onClick={() => useLayoutStore.getState().togglePanel(cellId, panel.id)}
                >
                  <ChevronIcon size={11} />
                </button>
                <span className="b3-panel-title">{panelTitle}</span>
                {members.length > 1 && <span className="ui-badge" data-tone="accent">병합 {members.length}</span>}
                {panel.collapsed && <span className="b3-panel-count">접힘</span>}
                <span className="flex-1" />
                {subPanels.length > 1 && (
                  <>
                    <button
                      type="button"
                      className="b3-panel-act"
                      disabled={index === 0}
                      aria-label={`${panelTitle} 위로 이동`}
                      title="패널 위로"
                      onClick={() => useLayoutStore.getState().movePanel(cellId, panel.id, -1)}
                    >
                      <ArrowIcon size={11} dir="up" />
                    </button>
                    <button
                      type="button"
                      className="b3-panel-act"
                      disabled={index === subPanels.length - 1}
                      aria-label={`${panelTitle} 아래로 이동`}
                      title="패널 아래로"
                      onClick={() => useLayoutStore.getState().movePanel(cellId, panel.id, 1)}
                    >
                      <ArrowIcon size={11} dir="down" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="b3-panel-act b3-row-act-danger"
                  aria-label={`${panelTitle} 닫기`}
                  title="패널 닫기"
                  onMouseEnter={() => setDangerPanelId(panel.id)}
                  onMouseLeave={() => setDangerPanelId(null)}
                  onClick={() => {
                    if (selectedTarget?.kind === "indicator" && members.some((m) => m.id === selectedTarget.id)) {
                      onSelectTarget(null);
                    }
                    setDangerPanelId(null);
                    removeIndicatorsWithUndo(cellId, members, `${panelTitle}을 닫았습니다`);
                  }}
                >
                  <CloseIcon size={11} />
                </button>
              </div>

              {!panel.collapsed && (
                <div className="b3-panel-body">
                  {members.map((config) => {
                    const selected = isIndicatorSelected(config.id);
                    const full = specName(config.spec);
                    const params = compactParams(config);
                    const hasColorSwatch = colorLine(config.spec) !== null;
                    const swatchCss = hasColorSwatch ? indicatorCssColor(shownColor(config.spec, config.style.colors)) : "var(--text-3)";
                    const slot = scales?.get(config.id)?.slot ?? null;
                    const prevPanel = index > 0 ? subPanels[index - 1]?.panel : null;
                    return (
                      <div
                        key={config.id}
                        className="b3-layer-row"
                        data-selected={selected || undefined}
                        data-hidden={!config.visible || undefined}
                        data-danger-hover={dangerRowId === config.id || undefined}
                        onClick={() => toggleSelectIndicator(config.id)}
                      >
                        {selected && <span aria-hidden="true" className="b3-select-notch" />}
                        <button
                          type="button"
                          className="b3-row-eye"
                          aria-label={`${full} ${config.visible ? "숨기기" : "보이기"}`}
                          aria-pressed={!config.visible}
                          onClick={(e) => {
                            e.stopPropagation();
                            useLayoutStore.getState().updateIndicator(cellId, config.id, { visible: !config.visible });
                          }}
                        >
                          <EyeIcon size={13} off={!config.visible} />
                        </button>
                        <span aria-hidden="true" className="b3-swatch-bar" style={{ background: swatchCss, height: Math.min(4, Math.max(2, config.style.width)) }} />
                        <button
                          type="button"
                          className="b3-row-main"
                          aria-label={`${full} 설정`}
                          aria-expanded={selected}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelectIndicator(config.id);
                          }}
                        >
                          <span className="b3-row-name">{KINDS[config.spec.kind].label}</span>
                          {params && <span className="b3-row-params">{params}</span>}
                        </button>
                        {slot && (
                          <button
                            type="button"
                            className="b3-axis-pill"
                            aria-label={`${full} Y축 전환 (현재 ${axisSlotLabel(slot)})`}
                            title="Y축 전환 (R → L → 독립)"
                            onClick={(e) => {
                              e.stopPropagation();
                              useLayoutStore.getState().setIndicatorAxis(cellId, config.id, nextIndicatorAxis(slot));
                            }}
                          >
                            {axisSlotLabel(slot)}
                          </button>
                        )}
                        <div className="b3-row-acts" onClick={(e) => e.stopPropagation()}>
                          {config.spec.kind === "volume" && (
                            <button
                              type="button"
                              className="b3-row-act"
                              aria-label="거래량 가격 패널에 겹치기"
                              title="가격 패널에 겹치기"
                              onClick={() => useLayoutStore.getState().setIndicatorPlacement(cellId, config.id, "price")}
                            >
                              <ArrowIcon size={11} dir="up" />
                            </button>
                          )}
                          {prevPanel && (
                            <button
                              type="button"
                              className="b3-row-act"
                              aria-label={`${full} 위 패널에 합치기`}
                              title="위 패널에 합치기"
                              onClick={() => useLayoutStore.getState().mergeIndicatorIntoPanel(cellId, config.id, prevPanel.id)}
                            >
                              ⤴
                            </button>
                          )}
                          {members.length > 1 && (
                            <button
                              type="button"
                              className="b3-row-act"
                              aria-label={`${full} 새 패널로 분리`}
                              title="새 패널로 분리"
                              onClick={() => useLayoutStore.getState().splitIndicatorToNewPanel(cellId, config.id, index + 1)}
                            >
                              ⤵
                            </button>
                          )}
                          <button
                            type="button"
                            className="b3-row-act b3-row-act-danger"
                            aria-label={`${full} 지우기`}
                            title="지우기"
                            onMouseEnter={() => setDangerRowId(config.id)}
                            onMouseLeave={() => setDangerRowId(null)}
                            onClick={() => {
                              if (selected) onSelectTarget(null);
                              setDangerRowId(null);
                              removeIndicatorWithUndo(cellId, config);
                            }}
                          >
                            <CloseIcon size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        {settings.indicators.length === 0 && (
          <div className="b3-empty-layers">
            <p>적용된 지표가 없습니다</p>
            <button type="button" className="btn btn-sm" onClick={() => onOpenQuickAdd("all")}>
              <PlusIcon size={12} />
              지표 추가하기
            </button>
          </div>
        )}
      </div>

      <footer className="b3-foot">
        <span className="b3-foot-status">
          <i aria-hidden="true" className="b3-status-dot" data-snapped={isSnapped || undefined} />
          {isSnapped ? "우측 고정" : "글래스 피크"} · 지표 {settings.indicators.length}
        </span>
        <div ref={cleanupRef} className="b3-cleanup-wrap">
          <button
            type="button"
            className="b3-cleanup-btn"
            aria-label="레이어 정리 메뉴"
            aria-expanded={cleanupOpen}
            onClick={() => onCleanupOpenChange(!cleanupOpen)}
          >
            정리
            <MoreIcon size={13} />
          </button>
          {cleanupOpen && (
            <div className="b3-cleanup-menu" role="menu" aria-label="레이어 정리">
              <button type="button" role="menuitem" disabled={subPanels.length === 0} onClick={toggleAllSubPanels}>
                {allSubPanelsCollapsed ? "아래 패널 모두 펼치기" : "아래 패널 모두 접기"}
              </button>
              <button type="button" role="menuitem" disabled={hiddenIndicators.length === 0} onClick={showAllHidden}>
                숨긴 지표 모두 보이기 ({hiddenIndicators.length})
              </button>
              <button type="button" role="menuitem" className="b3-cleanup-danger" disabled={hiddenIndicators.length === 0} onClick={removeAllHidden}>
                숨긴 지표 모두 삭제 ({hiddenIndicators.length})
              </button>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
