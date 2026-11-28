import { useEffect, useMemo, useRef, useState } from "react";
import { useSymbolInfos } from "../../api/queries";
import { colorLine, indicatorCssColor, KINDS, shownColor, specName } from "../../chart/indicators/kinds";
import { axisSlotLabel, nextIndicatorAxis, resolvePanelScales } from "../../chart/indicators/scales";
import type { ChartSettings, IndicatorConfig } from "../../chart/settings";
import type { WindowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { ArrowIcon, ChevronIcon, ChevronRightIcon, CloseIcon, EyeIcon, MoreIcon, PlusIcon } from "../icons";
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
  onSelectTarget(target: DockSelectionTarget): void;
  onOpenQuickAdd(category: AddCategory): void;
}

interface RowMenuAction {
  key: string;
  label: string;
  ariaLabel: string;
  run(): void;
}

function compactParams(config: IndicatorConfig): string {
  const label = KINDS[config.spec.kind].label;
  const full = specName(config.spec);
  if (full === label) return "";
  return full.startsWith(label) ? full.slice(label.length).trim() : treeChildLabel(config.spec);
}

function RowActionMenu({
  fullName,
  actions,
  open,
  onToggle,
  onClose,
}: {
  fullName: string;
  actions: readonly RowMenuAction[];
  open: boolean;
  onToggle(): void;
  onClose(): void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onClose]);

  if (actions.length === 0) return null;

  return (
    <div ref={wrapRef} className="b3-row-menu-wrap">
      <button
        type="button"
        className="b3-row-act"
        aria-label={`${fullName} 패널 작업`}
        aria-expanded={open}
        title="패널 이동 · 분리"
        onClick={onToggle}
      >
        <MoreIcon size={12} />
      </button>
      {open && (
        <div className="b3-row-menu" role="menu" aria-label={`${fullName} 패널 작업`}>
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              aria-label={action.ariaLabel}
              onClick={() => {
                action.run();
                onClose();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DockLayerList({
  cellId,
  settings,
  selectedTarget,
  onSelectTarget,
  onOpenQuickAdd,
}: DockLayerListProps) {
  const [dangerRowId, setDangerRowId] = useState<string | null>(null);
  const [dangerPanelId, setDangerPanelId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const compareInfos = useSymbolInfos(settings.compare);

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

  const toggleSelectIndicator = (id: string) => {
    setOpenMenuId(null);
    onSelectTarget(isIndicatorSelected(id) ? null : { kind: "indicator", id });
  };

  const toggleSelectMaGroup = () => {
    setOpenMenuId(null);
    onSelectTarget(isMaGroupSelected ? null : { kind: "maGroup" });
  };

  const priceIndicatorCount = maLines.length + priceNonMa.length + settings.compare.length;

  return (
    <div className="b3-layers-wrap">
      <div className="b3-layers-scroll">
        <section className="b3-panel-card" aria-label="가격 패널">
          <div className="b3-panel-head">
            <span className="b3-panel-title">가격 패널</span>
            <span className="b3-panel-count">{priceIndicatorCount}</span>
            <span className="flex-1" />
            <button
              type="button"
              className="b3-layer-pill"
              aria-pressed={settings.candlesOnTop}
              aria-label={settings.candlesOnTop ? "캔들 지표 위에 그리기 켜짐" : "캔들 지표 아래에 그리기"}
              title="캔들과 지표 겹침 순서 전환"
              onClick={() => useLayoutStore.getState().setCandlesOnTop(cellId, !settings.candlesOnTop)}
            >
              {settings.candlesOnTop ? "캔들 위" : "캔들 아래"}
            </button>
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
            {priceIndicatorCount === 0 && (
              <button type="button" className="b3-panel-empty-btn" onClick={() => onOpenQuickAdd("price")}>
                <PlusIcon size={11} />
                <span>가격 지표 없음 · 클릭해서 추가</span>
              </button>
            )}

            {maLines.length > 0 && (
              <div
                className="b3-layer-row"
                data-selected={isMaGroupSelected || undefined}
                data-hidden={maLines.every((line) => !line.visible) || undefined}
                data-danger-hover={dangerRowId === "ma-group" || undefined}
                onClick={toggleSelectMaGroup}
              >
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
                <span aria-hidden="true" className="b3-swatch-slot">
                  <span className="b3-ma-dots-grid">
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
                <div className="b3-row-right" onClick={(e) => e.stopPropagation()}>
                  <span className="b3-row-count">{maLines.filter((line) => line.visible).length}/{maLines.length}</span>
                  <span aria-hidden="true" className="b3-row-chev"><ChevronRightIcon size={11} /></span>
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
              const menuActions: RowMenuAction[] = config.spec.kind === "volume"
                ? [{
                  key: "split-volume",
                  label: "아래 패널로 분리",
                  ariaLabel: "거래량 아래 패널로 분리",
                  run: () => useLayoutStore.getState().setIndicatorPlacement(cellId, config.id, "panel"),
                }]
                : [];
              return (
                <div
                  key={config.id}
                  className="b3-layer-row"
                  data-selected={selected || undefined}
                  data-hidden={!config.visible || undefined}
                  data-danger-hover={dangerRowId === config.id || undefined}
                  onClick={() => toggleSelectIndicator(config.id)}
                >
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
                  <span aria-hidden="true" className="b3-swatch-slot">
                    <span className="b3-swatch-bar" style={{ background: swatchCss, height: Math.min(4, Math.max(2, config.style.width)) }} />
                  </span>
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
                  <div className="b3-row-right" onClick={(e) => e.stopPropagation()}>
                    <RowActionMenu
                      fullName={full}
                      actions={menuActions}
                      open={openMenuId === config.id}
                      onToggle={() => setOpenMenuId((cur) => (cur === config.id ? null : config.id))}
                      onClose={() => setOpenMenuId(null)}
                    />
                    <span aria-hidden="true" className="b3-row-chev"><ChevronRightIcon size={11} /></span>
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
                <div key={code} className="b3-layer-row b3-compare-row">
                  <span aria-hidden="true" className="b3-compare-mark">%</span>
                  <span aria-hidden="true" className="b3-swatch-slot">
                    <span className="b3-swatch-bar" style={{ background: COMPARE_TOKENS[index % COMPARE_TOKENS.length] }} />
                  </span>
                  <div className="b3-row-main">
                    <span className="b3-row-name">{name}</span>
                    <span className="b3-row-params">비교</span>
                  </div>
                  <div className="b3-row-right">
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
                </div>
              );
            })}
          </div>
        </section>

        {subPanels.map(({ panel, index, members }) => {
          const scales = members.length > 1 ? resolvePanelScales(settings.indicators, panel.id) : null;
          const panelTitle = `아래 패널 ${index + 1}`;
          const collapsedSummary = members.map((item) => KINDS[item.spec.kind].label).join(" · ");
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
                {panel.collapsed ? (
                  <span className="b3-panel-summary">· {collapsedSummary}</span>
                ) : (
                  members.length > 1 && <span className="b3-merge-badge">병합 {members.length}</span>
                )}
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
                    const menuActions: RowMenuAction[] = [];
                    if (config.spec.kind === "volume") {
                      menuActions.push({
                        key: "overlay-price",
                        label: "가격 패널에 겹치기",
                        ariaLabel: "거래량 가격 패널에 겹치기",
                        run: () => useLayoutStore.getState().setIndicatorPlacement(cellId, config.id, "price"),
                      });
                    }
                    if (prevPanel) {
                      menuActions.push({
                        key: "merge-up",
                        label: "위 패널에 합치기",
                        ariaLabel: `${full} 위 패널에 합치기`,
                        run: () => useLayoutStore.getState().mergeIndicatorIntoPanel(cellId, config.id, prevPanel.id),
                      });
                    }
                    if (members.length > 1) {
                      menuActions.push({
                        key: "split-new",
                        label: "새 패널로 분리",
                        ariaLabel: `${full} 새 패널로 분리`,
                        run: () => useLayoutStore.getState().splitIndicatorToNewPanel(cellId, config.id, index + 1),
                      });
                    }
                    return (
                      <div
                        key={config.id}
                        className="b3-layer-row"
                        data-selected={selected || undefined}
                        data-hidden={!config.visible || undefined}
                        data-danger-hover={dangerRowId === config.id || undefined}
                        onClick={() => toggleSelectIndicator(config.id)}
                      >
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
                        <span aria-hidden="true" className="b3-swatch-slot">
                          <span className="b3-swatch-bar" style={{ background: swatchCss, height: Math.min(4, Math.max(2, config.style.width)) }} />
                        </span>
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
                        <div className="b3-row-right" onClick={(e) => e.stopPropagation()}>
                          {slot && (
                            <button
                              type="button"
                              className="b3-axis-pill"
                              aria-label={`${full} Y축 전환 (현재 ${axisSlotLabel(slot)})`}
                              title="Y축 전환 (R → L → 독립)"
                              onClick={() => useLayoutStore.getState().setIndicatorAxis(cellId, config.id, nextIndicatorAxis(slot))}
                            >
                              {axisSlotLabel(slot)}
                            </button>
                          )}
                          <RowActionMenu
                            fullName={full}
                            actions={menuActions}
                            open={openMenuId === config.id}
                            onToggle={() => setOpenMenuId((cur) => (cur === config.id ? null : config.id))}
                            onClose={() => setOpenMenuId(null)}
                          />
                          <span aria-hidden="true" className="b3-row-chev"><ChevronRightIcon size={11} /></span>
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
        <span className="b3-foot-status">적용된 지표 {settings.indicators.length}개</span>
        <button type="button" className="b3-foot-add" onClick={() => onOpenQuickAdd("all")}>
          <PlusIcon size={11} />
          <span>지표 추가</span>
        </button>
      </footer>
    </div>
  );
}
