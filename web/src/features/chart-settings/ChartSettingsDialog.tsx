import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { CHART_STYLE_LABEL, type ChartStyle, clampVisibleBars, type ExtremeBasis, type PriceScale, shownScale, VISIBLE_BARS_MAX, VISIBLE_BARS_MIN } from "../../chart/settings";
import type { IndicatorWindow } from "../../persist/uiState";
import { useCell, useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { useSymbolInfo } from "../../api/queries";
import { PERIOD_LABEL } from "../../lib/symbol";
import { CommandFrame } from "../commands/CommandFrame";
import type { WindowId } from "../../layout/kinds";
import { CHART_SETTINGS_MENUS, type ChartSettingsMenuId, menuAfterKey } from "./menus";

const BAR_PRESETS = [null, 60, 120, 240, 480] as const;
const STYLES = Object.keys(CHART_STYLE_LABEL) as ChartStyle[];
const SCALES = [
  { value: "normal", label: "일반", title: "가격 그대로" },
  { value: "log", label: "로그", title: "로그 축 (L)" },
  { value: "percent", label: "%", title: "가격축을 화면 왼쪽 끝 봉 기준 % 변화로" },
] as const satisfies readonly { value: PriceScale; label: string; title: string }[];
const WINDOWS = [
  { value: "dialog", label: "가운데 창", title: "지표 창을 화면 가운데에 엽니다" },
  { value: "inspector", label: "차트 옆", title: "지표 창을 작업 영역의 창으로 엽니다. 좁은 화면에서는 가운데 창을 씁니다" },
] as const satisfies readonly { value: IndicatorWindow; label: string; title: string }[];
const EXTREME_BASES = [
  { value: "last", label: "현재가 대비", title: "최고가·최저가가 화면 오른쪽 끝 봉 종가보다 몇 % 높고 낮은지" },
  { value: "extreme", label: "고가·저가 대비", title: "화면 오른쪽 끝 봉 종가가 최고가보다 몇 % 내렸고 최저가보다 몇 % 올랐는지" },
] as const satisfies readonly { value: ExtremeBasis; label: string; title: string }[];
const SEGMENTS = "grid gap-1 rounded-m bg-chart-bg p-1";
const SEGMENT = "seg-btn !h-7 !min-w-0 !px-1 disabled:cursor-not-allowed disabled:opacity-50";

export function ChartSettingsDialog({ cellId, menu, onMenu, onClose }: { cellId: WindowId; menu: ChartSettingsMenuId; onMenu(menu: ChartSettingsMenuId): void; onClose(): void }) {
  const cell = useCell(cellId);
  const settings = cell.chartSettings;
  const name = useSymbolInfo(cell.symbol).data?.name ?? cell.symbol;
  const indicatorWindow = useUiStore((s) => s.prefs.indicatorWindow);
  const { setVisibleBars, setShowExtremes, setShowLegend, setShowOhlcChange, setExtremeBasis, setShowDaySeparators, setStyle, setScale } = useLayoutStore.getState();
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = shownScale(settings);
  const locked = settings.compare.length > 0;
  const tabId = (menuId: ChartSettingsMenuId) => `${id}-tab-${menuId}`;
  const current = CHART_SETTINGS_MENUS.find((m) => m.id === menu)!;
  const target = current.scope === "all" ? "모든 차트에 적용" : `${name} · ${PERIOD_LABEL[cell.period]}에 적용`;

  useEffect(() => document.getElementById(tabId(menu))?.focus(), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = menuAfterKey(menu, e.key);
    if (!next) return;
    e.preventDefault();
    onMenu(next);
    document.getElementById(tabId(next))?.focus();
  };

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

  return (
    <CommandFrame labelledBy={`${id}-title`} width="h-[min(480px,calc(100dvh-32px))] w-[min(720px,calc(100vw-32px))]" onClose={onClose}>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="차트 설정 메뉴" className="flex w-[208px] flex-none flex-col gap-1 border-r border-line p-3">
          <div className="flex flex-col gap-0.5 px-2 pb-2 pt-1">
            <h2 id={`${id}-title`} className="text-m font-semibold">차트 설정</h2>
            <span className="truncate text-xs text-text-2">{`${name} · ${PERIOD_LABEL[cell.period]}에 적용`}</span>
          </div>
          <div role="tablist" aria-orientation="vertical" aria-label="차트 설정 메뉴" onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
            {CHART_SETTINGS_MENUS.map((m) => (
              <button key={m.id} id={tabId(m.id)} type="button" role="tab" aria-selected={m.id === menu} aria-controls={`${id}-panel`} tabIndex={m.id === menu ? 0 : -1}
                onClick={() => onMenu(m.id)}
                className="flex h-9 items-center gap-2 rounded-m px-2 text-left text-text-2 hover:bg-hover hover:text-text aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:text-accent">
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
                {m.scope === "all" && <span aria-hidden="true" className="flex-none text-xs">모든 차트</span>}
              </button>
            ))}
          </div>
        </nav>
        <section role="tabpanel" id={`${id}-panel`} aria-labelledby={tabId(menu)} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 flex-none items-center gap-2 px-5">
            <span className="text-l font-semibold">{current.label}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-text-2">{target}</span>
            <button type="button" className="icon-btn flex-none" aria-label="닫기" onClick={onClose}><CloseIcon /></button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
            {menu === "bars" ? (
                  <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
                    <span id={`${id}-style`} className="text-text-2">봉 모양</span>
                    <div role="group" aria-labelledby={`${id}-style`} className={`${SEGMENTS} grid-cols-4`}>
                      {STYLES.map((style) => <button key={style} type="button" className={SEGMENT} aria-pressed={settings.style === style} onClick={() => setStyle(cellId, style)}>{CHART_STYLE_LABEL[style]}</button>)}
                    </div>
                    <span id={`${id}-scale`} className="text-text-2">가격 축</span>
                    <div role="group" aria-labelledby={`${id}-scale`} className={`${SEGMENTS} grid-cols-3`}>
                      {SCALES.map(({ value, label, title }) => (
                        <button key={value} type="button" className={SEGMENT} aria-pressed={shown === value} disabled={locked}
                          title={locked ? (value === "log" ? LOG_LOCKED : AXIS_LOCKED) : title} onClick={() => pickScale(value)}>{label}</button>
                      ))}
                    </div>
                    {locked && <p className="col-start-2 text-xs text-text-3">{AXIS_LOCKED}</p>}
                  </div>
                  <section className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <h3 id={`${id}-bars`} className="flex-1 text-xs text-text-2">화면에 보이는 봉</h3>
                      <input type="number" inputMode="numeric" min={VISIBLE_BARS_MIN} max={VISIBLE_BARS_MAX} step={1} aria-label="보이는 봉 수 직접 입력" placeholder="자동"
                        className="ui-field !min-h-8 w-[84px] text-right" value={draft ?? settings.visibleBars ?? ""}
                        onChange={(e) => setDraft(e.currentTarget.value)} onBlur={commitDraft}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }} />
                      <span className="text-text-2">봉</span>
                    </div>
                    <div role="group" aria-labelledby={`${id}-bars`} className={`${SEGMENTS} grid-cols-5`}>
                      {BAR_PRESETS.map((bars) => (
                        <button key={bars ?? "auto"} type="button" className={SEGMENT}
                          aria-pressed={settings.visibleBars === bars} title={bars === null ? "기본 봉 수 (데스크톱 130, 휴대폰 90, 분기봉·연봉은 전체)" : undefined}
                          onClick={() => { setDraft(null); setVisibleBars(cellId, bars); }}>{bars ?? "자동"}</button>
                      ))}
                    </div>
                  </section>
                </div>
            ) : menu === "display" ? (
                  <section className="flex flex-col gap-2">
                    <SettingSwitch label="범례" detail="종목·현재가·지표·비교 종목 범례를 표시. 봉 값(시·고·저·종·량)은 항상 보임"
                      checked={settings.showLegend} onChange={(on) => setShowLegend(cellId, on)} />
                    <SettingSwitch label="봉 값 등락률" detail="시·고·저·종 옆에 직전 봉 종가 대비 %"
                      checked={settings.showOhlcChange} onChange={(on) => setShowOhlcChange(cellId, on)} />
                    <SettingSwitch label="화면 내 최고·최저" detail="지금 보이는 봉 안에서 찾아 표시"
                      checked={settings.showExtremes} onChange={(on) => setShowExtremes(cellId, on)} />
                    <div className="flex items-center gap-2">
                      <span id={`${id}-extreme-basis`} className="flex-1 text-text-2">최고·최저 등락률</span>
                      <div role="group" aria-labelledby={`${id}-extreme-basis`} className={`${SEGMENTS} grid-cols-2`}>
                        {EXTREME_BASES.map(({ value, label, title }) => (
                          <button key={value} type="button" className={SEGMENT} title={title} aria-pressed={settings.extremeBasis === value}
                            disabled={!settings.showExtremes} onClick={() => setExtremeBasis(cellId, value)}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <SettingSwitch label="날짜 구분선" detail="분봉에서 날짜가 바뀌는 자리에 세로선"
                      checked={settings.showDaySeparators} onChange={(on) => setShowDaySeparators(cellId, on)} />
                  </section>
            ) : (
                  <section className="flex flex-col gap-2">
                    <p className="text-xs text-text-2">지표·비교 설정을 어떤 창으로 열지 정합니다.</p>
                    <div className="flex items-center gap-2">
                      <span id={`${id}-window`} className="flex-1 text-text-2">지표 창</span>
                      <div role="group" aria-labelledby={`${id}-window`} className={`${SEGMENTS} grid-cols-2`}>
                        {WINDOWS.map(({ value, label, title }) => <button key={value} type="button" className={SEGMENT} title={title} aria-pressed={indicatorWindow === value} onClick={() => useUiStore.getState().setIndicatorWindow(value)}>{label}</button>)}
                      </div>
                    </div>
                  </section>
            )}
          </div>
          <p className="flex-none border-t border-line px-5 py-2 text-xs text-text-2">바로 반영 · 레이아웃과 함께 저장</p>
        </section>
      </div>
    </CommandFrame>
  );
}

function SettingSwitch({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} title={detail} className="ui-switch" onClick={() => onChange(!checked)}>
      <span className="flex-1 text-left font-medium leading-snug">{label}</span>
      <span aria-hidden="true" className="ui-switch-track"><span /></span>
    </button>
  );
}
