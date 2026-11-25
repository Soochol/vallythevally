import { type ReactNode, useId, useState } from "react";
import { CHART_STYLE_LABEL, type ChartStyle, clampVisibleBars, type ExtremeBasis, type PriceScale, shownScale, VISIBLE_BARS_MAX, VISIBLE_BARS_MIN } from "../../chart/settings";
import type { IndicatorWindow } from "../../persist/uiState";
import { chartWindow, useCell, useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { useShownIndicatorWindow } from "../indicator-command/open";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL } from "../../lib/symbol";
import { DialogFrame } from "../dialog/DialogParts";
import { Badge } from "../ui/Badge";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import type { WindowId } from "../../layout/kinds";
import { CHART_SETTINGS_SECTIONS, type ChartSettingsSectionId, SCOPE_LABEL, scopeTitle } from "./menus";

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

export function ChartSettingsDialog({ cellId, onClose }: { cellId: WindowId; onClose(): void }) {
  const cell = useCell(cellId);
  const settings = cell.chartSettings;
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const cellName = `${name} · ${PERIOD_LABEL[cell.period]}`;
  const indicatorWindow = useShownIndicatorWindow();
  const { setVisibleBars, setShowExtremes, setShowLegend, setShowOhlcChange, setExtremeBasis, setShowDaySeparators, setStyle, setScale } = useLayoutStore.getState();
  const [initialSettings] = useState(() => chartWindow(useLayoutStore.getState().layout, cellId).chartSettings);
  const [initialIndicatorWindow] = useState(() => useUiStore.getState().prefs.indicatorWindow);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = shownScale(settings);
  const locked = settings.compare.length > 0;

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === "") return setVisibleBars(cellId, null);
    const bars = clampVisibleBars(Number(draft));
    if (bars !== null) setVisibleBars(cellId, bars);
  };
  const handleClose = (reason?: "escape" | "outside") => {
    if (reason === "escape") {
      setDraft(null);
      useLayoutStore.getState().setChartSettings(cellId, initialSettings);
      useUiStore.getState().setIndicatorWindow(initialIndicatorWindow);
    } else {
      commitDraft();
    }
    onClose();
  };
  const pickScale = (scale: PriceScale) => {
    const next = scale === "normal" ? scale : pressScale(settings, scale);
    if (next) setScale(cellId, next);
  };
  const section = (sectionId: ChartSettingsSectionId, children: ReactNode) => {
    const { label, scope } = CHART_SETTINGS_SECTIONS.find((s) => s.id === sectionId)!;
    return (
      <section aria-labelledby={`${id}-${sectionId}`} className="cs-section">
        <header className="cs-section-head">
          <h3 id={`${id}-${sectionId}`}>{label}</h3>
          <span title={scopeTitle(scope, cellName)}><Badge tone={scope === "all" ? "accent" : "neutral"}>{SCOPE_LABEL[scope]}</Badge></span>
        </header>
        {children}
      </section>
    );
  };

  return (
    <DialogFrame solid width="cs-dialog" labelledBy={`${id}-title`} onClose={handleClose}>
      <div data-chart-control="" className="cs-body">
        <header className="cs-head">
          <h2 id={`${id}-title`}>차트 설정</h2>
          <span className="cs-cell">{cellName}</span>
          <button type="button" className="icon-btn flex-none" aria-label="닫기" onClick={() => handleClose()}><CloseIcon /></button>
        </header>
        {section("bars", <>
          <div className="cs-row"><span className="cs-name">봉 모양</span><Segmented mode="pressed" label="봉 모양" options={STYLE_OPTIONS} value={settings.style} onChange={(style) => setStyle(cellId, style)} /></div>
          <div className="cs-row">
            <span className="cs-name">가격 축</span>
            <Segmented mode="pressed" label="가격 축" value={shown} onChange={pickScale}
              options={SCALES.map(({ value, label, title }): SegmentedOption<PriceScale> => ({ value, label, disabled: locked, title: locked ? (value === "log" ? LOG_LOCKED : AXIS_LOCKED) : title }))} />
          </div>
          {locked && <p className="cs-note">{AXIS_LOCKED}</p>}
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
        </>)}
        {section("display", <>
          <SettingSwitch label="범례" detail="종목·현재가·지표·비교 종목 범례를 표시. 봉 값(시·고·저·종·량)은 항상 보임" checked={settings.showLegend} onChange={(on) => setShowLegend(cellId, on)} />
          <SettingSwitch label="봉 값 등락률" detail="시·고·저·종 옆에 직전 봉 종가 대비 %" checked={settings.showOhlcChange} onChange={(on) => setShowOhlcChange(cellId, on)} />
          <SettingSwitch label="화면 내 최고·최저" detail="지금 보이는 봉 안에서 찾아 표시" checked={settings.showExtremes} onChange={(on) => setShowExtremes(cellId, on)} />
          <div className="cs-row cs-wrap">
            <span className="cs-name">최고·최저 등락률</span>
            <Segmented mode="pressed" label="최고·최저 등락률" options={EXTREME_BASES.map((option): SegmentedOption<ExtremeBasis> => ({ ...option, disabled: !settings.showExtremes }))} value={settings.extremeBasis} onChange={(basis) => setExtremeBasis(cellId, basis)} />
          </div>
          <SettingSwitch label="날짜 구분선" detail="분봉에서 날짜가 바뀌는 자리에 세로선" checked={settings.showDaySeparators} onChange={(on) => setShowDaySeparators(cellId, on)} />
        </>)}
        {section("windows", (
          <div className="cs-row">
            <span className="cs-name">지표 창</span>
            <Segmented mode="pressed" label="지표 창" options={WINDOW_OPTIONS} value={indicatorWindow} onChange={(value) => useUiStore.getState().setIndicatorWindow(value)} />
          </div>
        ))}
        <p className="cs-foot">자동 저장 · Esc로 되돌리고 닫기</p>
      </div>
    </DialogFrame>
  );
}

function SettingSwitch({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} title={detail} className="ui-switch cs-switch" onClick={() => onChange(!checked)}>
      <span className="cs-name flex-1 text-left">{label}</span>
      <span aria-hidden="true" className="ui-switch-track"><span /></span>
    </button>
  );
}
