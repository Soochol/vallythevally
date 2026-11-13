import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { CHART_STYLE_LABEL, type ChartStyle, clampVisibleBars, type PriceScale, shownScale, VISIBLE_BARS_MAX, VISIBLE_BARS_MIN } from "../../chart/settings";
import type { IndicatorWindow } from "../../persist/uiState";
import { type Slot, useCell, useLayoutStore } from "../../stores/layout";
import { useUiStore } from "../../stores/ui";
import { CloseIcon } from "../icons";
import { AXIS_LOCKED, LOG_LOCKED, pressScale } from "../indicator-dialog/compareForm";
import { Popover } from "../overlay/Popover";

const BAR_PRESETS = [null, 60, 120, 240, 480] as const;
const STYLES = Object.keys(CHART_STYLE_LABEL) as ChartStyle[];
const SCALES = [
  { value: "normal", label: "일반", title: "가격 그대로" },
  { value: "log", label: "로그", title: "로그 축 (L)" },
  { value: "percent", label: "%", title: "가격축을 화면 왼쪽 끝 봉 기준 % 변화로" },
] as const satisfies readonly { value: PriceScale; label: string; title: string }[];
const WINDOWS = [
  { value: "dialog", label: "가운데 창", title: "지표 창을 화면 가운데에 엽니다" },
  { value: "inspector", label: "차트 옆", title: "지표 창을 오른쪽 패널에 엽니다. 좁은 화면에서는 가운데 창을 씁니다" },
] as const satisfies readonly { value: IndicatorWindow; label: string; title: string }[];
const SEGMENTS = "grid gap-1 rounded-m bg-chart-bg p-1";
const SEGMENT = "seg-btn !h-7 !min-w-0 !px-1 disabled:cursor-not-allowed disabled:opacity-50";

export function ChartSettingsPopover({ slot, anchor, onClose }: { slot: Slot; anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const settings = useCell(slot).chartSettings;
  const indicatorWindow = useUiStore((s) => s.prefs.indicatorWindow);
  const { setVisibleBars, setShowExtremes, setStyle, setScale } = useLayoutStore.getState();
  const [draft, setDraft] = useState<string | null>(null);
  const firstFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const shown = shownScale(settings);
  const locked = settings.compare.length > 0;
  const customBars = !BAR_PRESETS.some((bars) => bars === settings.visibleBars);
  const focusFirst = (node: HTMLElement | null) => { if (node) firstFocus.current = node; };

  useEffect(() => firstFocus.current?.focus(), []);

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === "") return setVisibleBars(slot, null);
    const bars = clampVisibleBars(Number(draft));
    if (bars !== null) setVisibleBars(slot, bars);
  };
  const pickScale = (scale: PriceScale) => {
    const next = scale === "normal" ? scale : pressScale(settings, scale);
    if (next) setScale(slot, next);
  };

  return (
    <Popover role="dialog" aria-labelledby={`${id}-title`} anchor={anchor} focus={false} onClose={onClose} className="flex w-[320px] flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h2 id={`${id}-title`} className="text-m font-semibold">차트 설정</h2>
        <button type="button" className="icon-btn !size-7" aria-label="닫기" onClick={onClose}><CloseIcon /></button>
      </header>
      <section className="flex flex-col gap-2">
        <h3 id={`${id}-bars`} className="text-xs text-text-2">화면에 보이는 봉</h3>
        <div role="group" aria-labelledby={`${id}-bars`} className={`${SEGMENTS} grid-cols-5`}>
          {BAR_PRESETS.map((bars) => (
            <button key={bars ?? "auto"} ref={settings.visibleBars === bars ? focusFirst : undefined} type="button" className={SEGMENT}
              aria-pressed={settings.visibleBars === bars} title={bars === null ? "기본 봉 수 (데스크톱 130, 휴대폰 90, 분기봉·연봉은 전체)" : undefined}
              onClick={() => { setDraft(null); setVisibleBars(slot, bars); }}>{bars ?? "자동"}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-text-2">직접 입력</span>
          <input type="number" inputMode="numeric" min={VISIBLE_BARS_MIN} max={VISIBLE_BARS_MAX} step={1} aria-label="보이는 봉 수 직접 입력" placeholder="자동"
            ref={customBars ? focusFirst : undefined}
            className="ui-field !min-h-8 w-[84px] text-right" value={draft ?? settings.visibleBars ?? ""}
            onChange={(e) => setDraft(e.currentTarget.value)} onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }} />
          <span className="text-text-2">봉</span>
        </div>
      </section>
      <div className="h-px bg-line" />
      <section className="flex flex-col gap-2">
        <h3 className="text-xs text-text-2">표시</h3>
        <button type="button" role="switch" aria-checked={settings.showExtremes} className="ui-switch" onClick={() => setShowExtremes(slot, !settings.showExtremes)}>
          <span className="flex flex-1 flex-col text-left leading-snug">
            <span className="font-medium">화면 내 최고·최저</span>
            <span className="text-xs text-text-2">지금 보이는 봉 안에서 찾아 표시</span>
          </span>
          <span aria-hidden="true" className="ui-switch-track"><span /></span>
        </button>
      </section>
      <div className="h-px bg-line" />
      <div className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5">
        <span id={`${id}-style`} className="text-text-2">봉 모양</span>
        <div role="group" aria-labelledby={`${id}-style`} className={`${SEGMENTS} grid-cols-4`}>
          {STYLES.map((style) => <button key={style} type="button" className={SEGMENT} aria-pressed={settings.style === style} onClick={() => setStyle(slot, style)}>{CHART_STYLE_LABEL[style]}</button>)}
        </div>
        <span id={`${id}-scale`} className="text-text-2">가격 축</span>
        <div role="group" aria-labelledby={`${id}-scale`} className={`${SEGMENTS} grid-cols-3`}>
          {SCALES.map(({ value, label, title }) => (
            <button key={value} type="button" className={SEGMENT} aria-pressed={shown === value} disabled={locked}
              title={locked ? (value === "log" ? LOG_LOCKED : AXIS_LOCKED) : title} onClick={() => pickScale(value)}>{label}</button>
          ))}
        </div>
        <span id={`${id}-window`} className="text-text-2">지표 창</span>
        <div role="group" aria-labelledby={`${id}-window`} className={`${SEGMENTS} grid-cols-2`}>
          {WINDOWS.map(({ value, label, title }) => <button key={value} type="button" className={SEGMENT} title={title} aria-pressed={indicatorWindow === value} onClick={() => useUiStore.getState().setIndicatorWindow(value)}>{label}</button>)}
        </div>
      </div>
      {locked && <p className="text-xs text-text-3">{AXIS_LOCKED}</p>}
      <p className="text-xs text-text-2">활성 칸에 바로 반영 · 레이아웃과 함께 저장</p>
    </Popover>
  );
}
