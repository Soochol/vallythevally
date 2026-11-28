import { Fragment, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { CHART_STYLE_LABEL, type ChartSettings, type ChartStyle, clampVisibleBars, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type PriceScale, shownScale, VISIBLE_BARS_MAX, VISIBLE_BARS_MIN } from "../../chart/settings";
import type { IndicatorWindow } from "../../persist/uiState";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL } from "../../lib/symbol";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { AXIS_LOCKED, LOG_LOCKED, pressScale, stepIndex } from "../indicator-dialog/compareForm";
import { useShownIndicatorWindow } from "../indicator-command/open";
import { Badge } from "../ui/Badge";
import { Kbd } from "../ui/Kbd";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Switch } from "../ui/Switch";
import type { WindowId } from "../../layout/kinds";
import { CHART_SETTINGS_SECTIONS, type ChartSettingsScope, type ChartSettingsSectionId, SCOPE_LABEL, scopeTitle } from "./menus";

const BAR_PRESETS = [null, 60, 120, 240, 480] as const;
const STYLE_OPTIONS = (Object.entries(CHART_STYLE_LABEL) as [ChartStyle, string][]).map(([value, label]): SegmentedOption<ChartStyle> => ({ value, label }));
const SCALES = [
  { value: "normal", label: "일반", title: "가격 그대로" },
  { value: "log", label: "로그", title: "로그 축 (L)" },
  { value: "percent", label: "%", title: "가격축을 화면 왼쪽 끝 봉 기준 % 변화로" },
] as const satisfies readonly { value: PriceScale; label: string; title: string }[];
const WINDOW_OPTIONS = [
  { value: "dialog", label: "가운데 창", title: "지표 창을 화면 가운데에 엽니다" },
  { value: "inspector", label: "차트 옆", title: "지표 창을 작업 영역의 창으로 엽니다. 좁은 화면에서는 가운데 창을 씁니다" },
] as const satisfies readonly SegmentedOption<IndicatorWindow>[];
const EXTREME_BASES = [
  { value: "last", label: "현재가 대비", title: "최고가·최저가가 화면 오른쪽 끝 봉 종가보다 몇 % 높고 낮은지" },
  { value: "extreme", label: "고가·저가 대비", title: "화면 오른쪽 끝 봉 종가가 최고가보다 몇 % 내렸고 최저가보다 몇 % 올랐는지" },
] as const satisfies readonly SegmentedOption<ExtremeBasis>[];
const BAR_PRESET_OPTIONS = BAR_PRESETS.map((bars): SegmentedOption<string> => ({ value: String(bars), label: bars ?? "자동", title: bars === null ? "기본 봉 수 (데스크톱 130, 휴대폰 90, 분기봉·연봉은 전체)" : undefined }));
const DEFAULT_INDICATOR_WINDOW: IndicatorWindow = "dialog";

function isSectionModified(sectionId: ChartSettingsSectionId, settings: ChartSettings, indicatorWindow: IndicatorWindow): boolean {
  if (sectionId === "bars") {
    return settings.style !== DEFAULT_CHART_SETTINGS.style
      || settings.scale !== DEFAULT_CHART_SETTINGS.scale
      || settings.visibleBars !== DEFAULT_CHART_SETTINGS.visibleBars
      || settings.regularHoursOnly !== DEFAULT_CHART_SETTINGS.regularHoursOnly
      || settings.scalePriceOnly !== DEFAULT_CHART_SETTINGS.scalePriceOnly;
  }
  if (sectionId === "display") {
    return settings.showLegend !== DEFAULT_CHART_SETTINGS.showLegend
      || settings.showOhlcChange !== DEFAULT_CHART_SETTINGS.showOhlcChange
      || settings.showExtremes !== DEFAULT_CHART_SETTINGS.showExtremes
      || settings.extremeBasis !== DEFAULT_CHART_SETTINGS.extremeBasis
      || settings.candlesOnTop !== DEFAULT_CHART_SETTINGS.candlesOnTop;
  }
  if (sectionId === "grid") {
    return settings.showHorzGrid !== DEFAULT_CHART_SETTINGS.showHorzGrid
      || settings.showVertGrid !== DEFAULT_CHART_SETTINGS.showVertGrid
      || settings.showDaySeparators !== DEFAULT_CHART_SETTINGS.showDaySeparators;
  }
  return indicatorWindow !== DEFAULT_INDICATOR_WINDOW;
}

const COMPACT_SECTION_LABEL: Record<ChartSettingsSectionId, string> = {
  bars: "봉·축",
  display: "범례",
  grid: "격자",
  windows: "창",
};

const SCALE_LABEL: Record<PriceScale, string> = { normal: "일반", log: "로그", percent: "%" };
const SECTION_GROUPS = [
  { scope: "cell", label: "이 칸 설정" },
  { scope: "all", label: "공통 설정" },
] as const satisfies readonly { scope: ChartSettingsScope; label: string }[];

function sectionSummary(sectionId: ChartSettingsSectionId, settings: ChartSettings, indicatorWindow: IndicatorWindow): string {
  if (sectionId === "bars") {
    const scale = settings.compare.length > 0 ? "% 고정" : SCALE_LABEL[shownScale(settings)];
    const bars = settings.visibleBars === null ? "자동" : `${settings.visibleBars}봉`;
    return `${CHART_STYLE_LABEL[settings.style]} · ${scale} · ${bars}`;
  }
  if (sectionId === "display") {
    const parts = [settings.showLegend ? "범례 켜짐" : "범례 꺼짐"];
    if (settings.showOhlcChange) parts.push("등락률");
    if (settings.showExtremes) parts.push("최고·최저");
    return parts.join(" · ");
  }
  if (sectionId === "grid") {
    const parts: string[] = [];
    if (settings.showHorzGrid) parts.push("가로");
    if (settings.showVertGrid) parts.push("세로");
    if (settings.showDaySeparators) parts.push("날짜선");
    return parts.length > 0 ? `${parts.join("·")} 켜짐` : "모두 꺼짐";
  }
  return indicatorWindow === "dialog" ? "가운데 창" : "차트 옆";
}

export function ChartSettingsSections({ cellId, compact = false }: { cellId: WindowId; compact?: boolean }) {
  const cell = useCell(cellId);
  const settings = cell.chartSettings;
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const cellName = `${name} · ${PERIOD_LABEL[cell.period]}`;
  const indicatorWindow = useShownIndicatorWindow();
  const { setChartSettings, setVisibleBars, setShowExtremes, setShowLegend, setShowOhlcChange, setExtremeBasis, setShowDaySeparators, setShowHorzGrid, setShowVertGrid, setRegularHoursOnly, setCandlesOnTop, setScalePriceOnly, setStyle, setScale } = useLayoutStore.getState();
  const [activeSection, setActiveSection] = useState<ChartSettingsSectionId>("bars");
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = shownScale(settings);
  const locked = settings.compare.length > 0;
  const anyModified = CHART_SETTINGS_SECTIONS.some((s) => isSectionModified(s.id, settings, indicatorWindow));
  const currentMeta = CHART_SETTINGS_SECTIONS.find((s) => s.id === activeSection)!;

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === "") return setVisibleBars(cellId, null);
    const bars = clampVisibleBars(Number(draft));
    if (bars !== null) setVisibleBars(cellId, bars);
  };
  const pickScale = (scale: PriceScale) => {
    const next = scale === "normal" ? scale : pressScale(settings, scale);
    if (next) setScale(cellId, next);
  };
  const resetDefaults = () => {
    setDraft(null);
    setChartSettings(cellId, {
      ...settings,
      style: DEFAULT_CHART_SETTINGS.style,
      scale: locked ? settings.scale : DEFAULT_CHART_SETTINGS.scale,
      visibleBars: DEFAULT_CHART_SETTINGS.visibleBars,
      showLegend: DEFAULT_CHART_SETTINGS.showLegend,
      showOhlcChange: DEFAULT_CHART_SETTINGS.showOhlcChange,
      showExtremes: DEFAULT_CHART_SETTINGS.showExtremes,
      extremeBasis: DEFAULT_CHART_SETTINGS.extremeBasis,
      showHorzGrid: DEFAULT_CHART_SETTINGS.showHorzGrid,
      showVertGrid: DEFAULT_CHART_SETTINGS.showVertGrid,
      showDaySeparators: DEFAULT_CHART_SETTINGS.showDaySeparators,
      regularHoursOnly: DEFAULT_CHART_SETTINGS.regularHoursOnly,
      candlesOnTop: DEFAULT_CHART_SETTINGS.candlesOnTop,
      scalePriceOnly: DEFAULT_CHART_SETTINGS.scalePriceOnly,
    });
    useUiStore.getState().setIndicatorWindow(DEFAULT_INDICATOR_WINDOW);
  };

  const renderForm = (): ReactNode => {
    if (activeSection === "bars") {
      return (
        <div className="cs-group">
          <div className="cs-row"><span className="cs-name">봉 모양</span><Segmented mode="pressed" label="봉 모양" options={STYLE_OPTIONS} value={settings.style} onChange={(style) => setStyle(cellId, style)} /></div>
          <div className="cs-row">
            <span className="cs-name">가격 축</span>
            <Segmented mode="pressed" label="가격 축" value={shown} onChange={pickScale}
              options={SCALES.map(({ value, label, title }): SegmentedOption<PriceScale> => ({ value, label, disabled: locked, title: locked ? (value === "log" ? LOG_LOCKED : AXIS_LOCKED) : title }))} />
          </div>
          {locked && <p className="cs-note">{AXIS_LOCKED}</p>}
          <SettingSwitch label="가격만 축에 맞춤" detail="가격 패널 지표를 제외하고 캔들 가격만으로 Y축 자동 범위를 맞춤" checked={settings.scalePriceOnly} onChange={(on) => setScalePriceOnly(cellId, on)} />
          <div className="cs-divider" />
          <div className="cs-row">
            <span className="cs-name">화면에 보이는 봉</span>
            <input type="number" inputMode="numeric" min={VISIBLE_BARS_MIN} max={VISIBLE_BARS_MAX} step={1} aria-label="보이는 봉 수 직접 입력" placeholder="자동"
              className="ui-field cs-input" value={draft ?? settings.visibleBars ?? ""}
              onChange={(e) => setDraft(e.currentTarget.value)} onBlur={commitDraft}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }} />
            <span className="cs-unit">봉</span>
          </div>
          <Segmented mode="pressed" label="화면에 보이는 봉" options={BAR_PRESET_OPTIONS} value={String(settings.visibleBars)} className="cs-presets"
            onChange={(bars) => { setDraft(null); setVisibleBars(cellId, bars === "null" ? null : Number(bars)); }} />
          <div className="cs-divider" />
          <SettingSwitch label="정규장만 보기" detail="분봉에서 정규장(09:00~15:30) 봉만 표시" checked={settings.regularHoursOnly} onChange={(on) => setRegularHoursOnly(cellId, on)} />
        </div>
      );
    }
    if (activeSection === "display") {
      return (
        <div className="cs-group">
          <SettingSwitch label="범례" detail="종목·현재가·지표·비교 종목 범례를 표시. 봉 값(시·고·저·종)은 항상 보임" checked={settings.showLegend} onChange={(on) => setShowLegend(cellId, on)} />
          <SettingSwitch label="봉 값 등락률" detail="시·고·저·종 옆에 직전 봉 종가 대비 %" checked={settings.showOhlcChange} onChange={(on) => setShowOhlcChange(cellId, on)} />
          <div className="cs-divider" />
          <SettingSwitch label="화면 내 최고·최저" detail="지금 보이는 봉 안에서 찾아 표시" checked={settings.showExtremes} onChange={(on) => setShowExtremes(cellId, on)} />
          <div className="cs-row cs-wrap">
            <span className="cs-name">최고·최저 등락률</span>
            <Segmented mode="pressed" label="최고·최저 등락률" options={EXTREME_BASES.map((option): SegmentedOption<ExtremeBasis> => ({ ...option, disabled: !settings.showExtremes }))} value={settings.extremeBasis} onChange={(basis) => setExtremeBasis(cellId, basis)} />
          </div>
          <div className="cs-divider" />
          <SettingSwitch label="캔들을 지표 위에" detail="이동평균·볼린저·일목 등 가격 패널 지표 위에 캔들을 그림" checked={settings.candlesOnTop} onChange={(on) => setCandlesOnTop(cellId, on)} />
        </div>
      );
    }
    if (activeSection === "grid") {
      return (
        <div className="cs-group">
          <SettingSwitch label="가로 격자선" detail="가격 축 눈금에 맞춰 가로선을 표시" checked={settings.showHorzGrid} onChange={(on) => setShowHorzGrid(cellId, on)} />
          <SettingSwitch label="세로 격자선" detail="시간 축 눈금에 맞춰 세로선을 표시" checked={settings.showVertGrid} onChange={(on) => setShowVertGrid(cellId, on)} />
          <div className="cs-divider" />
          <SettingSwitch label="날짜 구분선" detail="분봉에서 날짜가 바뀌는 자리에 세로선" checked={settings.showDaySeparators} onChange={(on) => setShowDaySeparators(cellId, on)} />
        </div>
      );
    }
    return (
      <div className="cs-group">
        <div className="cs-row cs-wrap">
          <span className="cs-name">지표 창</span>
          <Segmented mode="pressed" label="지표 창" options={WINDOW_OPTIONS} value={indicatorWindow} onChange={(value) => useUiStore.getState().setIndicatorWindow(value)} />
        </div>
      </div>
    );
  };

  const tabId = (sectionId: ChartSettingsSectionId) => `${id}-tab-${sectionId}`;
  const handleNavKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const currentIndex = CHART_SETTINGS_SECTIONS.findIndex((s) => s.id === activeSection);
    const next = CHART_SETTINGS_SECTIONS[stepIndex(currentIndex, event.key === "ArrowDown" ? 1 : -1, CHART_SETTINGS_SECTIONS.length)];
    if (!next) return;
    setActiveSection(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };

  const panelContent = (
    <section role="region" aria-labelledby={`${id}-${activeSection}`} className="cs-content">
      <div className="cs-pane-scroll">
        <header className="cs-pane-head">
          <div className="cs-pane-title-wrap">
            <h3 id={`${id}-${activeSection}`} className="cs-pane-title">{currentMeta.label}</h3>
            <p className="cs-pane-desc">{currentMeta.description}</p>
          </div>
          <span title={scopeTitle(currentMeta.scope, cellName)}>
            <Badge tone={currentMeta.scope === "all" ? "accent" : "neutral"}>{SCOPE_LABEL[currentMeta.scope]}</Badge>
          </span>
        </header>
        {renderForm()}
      </div>
    </section>
  );

  if (compact) {
    return (
      <div className="cs-compact-layout">
        <nav className="cs-dock-pills" role="tablist" aria-label="차트 설정 메뉴">
          {CHART_SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-label={s.label}
              aria-selected={activeSection === s.id}
              data-modified={isSectionModified(s.id, settings, indicatorWindow) ? "true" : undefined}
              className="cs-dock-pill"
              title={s.label}
              onClick={() => setActiveSection(s.id)}
            >
              <span>{COMPACT_SECTION_LABEL[s.id]}</span>
              <span aria-hidden="true" className="cs-mod-dot" />
            </button>
          ))}
        </nav>
        {panelContent}
        <footer className="cs-foot-bar">
          <button type="button" className="cs-reset-btn cs-reset-compact" disabled={!anyModified} onClick={resetDefaults}>기본값 복원</button>
          <span className="cs-foot">자동 저장</span>
        </footer>
      </div>
    );
  }

  return (
    <div className="cs-layout">
      <aside className="cs-sidebar" aria-label="차트 설정 메뉴">
        <nav className="cs-nav" role="tablist" aria-orientation="vertical" aria-label="차트 설정 메뉴" onKeyDown={handleNavKeyDown}>
          {SECTION_GROUPS.map((group) => {
            const items = CHART_SETTINGS_SECTIONS.filter((s) => s.scope === group.scope);
            return (
              <Fragment key={group.scope}>
                <div className="cs-nav-group"><span>{group.label}</span><span>{items.length}</span></div>
                {items.map((s) => (
                  <button
                    key={s.id}
                    id={tabId(s.id)}
                    type="button"
                    role="tab"
                    aria-label={s.label}
                    aria-selected={activeSection === s.id}
                    data-modified={isSectionModified(s.id, settings, indicatorWindow) ? "true" : undefined}
                    className="cs-nav-item"
                    onClick={() => setActiveSection(s.id)}
                  >
                    <span className="cs-nav-text">
                      <span className="cs-nav-label">{s.label}</span>
                      <span aria-hidden="true" className="cs-nav-sub">{sectionSummary(s.id, settings, indicatorWindow)}</span>
                    </span>
                    <span aria-hidden="true" className="cs-mod-dot" />
                  </button>
                ))}
              </Fragment>
            );
          })}
        </nav>
      </aside>
      {panelContent}
      <footer className="cs-foot-bar">
        <span className="ic-hints">
          <span><Kbd>↑↓</Kbd> 고르기</span>
          <span><Kbd>Esc</Kbd> 되돌리고 닫기</span>
          <span>자동 저장</span>
        </span>
        <button type="button" className="cs-reset-btn" disabled={!anyModified} onClick={resetDefaults}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 8a5.5 5.5 0 1 0 1.4-3.7L2.5 5.5" />
            <path d="M2.5 2.5v3h3" />
          </svg>
          <span>기본값 복원</span>
        </button>
      </footer>
    </div>
  );
}

function SettingSwitch({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange(on: boolean): void }) {
  return (
    <Switch
      checked={checked}
      title={detail}
      className="cs-switch"
      label={
        <span className="cs-switch-text">
          <span className="cs-name">{label}</span>
          <span className="cs-detail">{detail}</span>
        </span>
      }
      onChange={onChange}
    />
  );
}
