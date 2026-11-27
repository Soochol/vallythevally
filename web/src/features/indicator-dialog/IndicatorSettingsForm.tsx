import { useEffect, useId, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { INDICATOR_COLORS, indicatorCssColor, KINDS, type IndicatorColor, type IndicatorToken } from "../../chart/indicators/kinds";
import { loadValidator } from "../../chart/indicators/validate";
import { BAR_OPACITY_MAX, BAR_OPACITY_MIN, DEFAULT_ICHIMOKU_STYLE, ICHIMOKU_CLOUD_OPACITY_MAX, ICHIMOKU_CLOUD_OPACITY_MIN, type IchimokuStyle, type LineWidth } from "../../chart/settings";
import { isHexColor, type HexColor } from "../../lib/colors";
import { Errors, Row, Segment } from "../dialog/DialogParts";
import { ColorStyleTrigger } from "../color/ColorStylePopover";
import { ColorTable, type ThemeSwatch } from "../color/ColorTable";
import { useColorMore } from "../color/colorMore";
import { canOverlayPrice, hasBarOpacity, hasColor, indicatorPeriodNotice, placeErrors, type Draft, type FieldError, type Validate } from "./indicatorForm";

const METHODS = [
  ["sma", "단순"],
  ["ema", "지수"],
] as const satisfies readonly (readonly [MaMethod, string])[];
const WIDTHS = [
  [1, "1"],
  [2, "2"],
  [3, "3"],
  [4, "4"],
  [5, "5"],
] as const satisfies readonly (readonly [LineWidth, string])[];

const PERIOD_PRESETS = ["5", "20", "60", "120"] as const;

const ICHIMOKU_PERIOD_PRESETS = [
  { label: "표준 (9·26·52)", conversion: "9", base: "26", spanB: "52", displacement: "26" },
  { label: "단기 (7·22·44)", conversion: "7", base: "22", spanB: "44", displacement: "22" },
] as const;

const ICHIMOKU_TOGGLES: readonly (readonly [key: keyof Omit<IchimokuStyle, "cloudOpacity">, label: string])[] = [
  ["showCloud", "구름대"],
  ["showConversion", "전환선"],
  ["showBase", "기준선"],
  ["showSpanA", "선행스팬 1"],
  ["showSpanB", "선행스팬 2"],
  ["showLagging", "후행스팬"],
];

const THEME_SWATCHES: readonly ThemeSwatch<IndicatorToken>[] = INDICATOR_COLORS.map((token, i) => ({ name: `테마 ${i + 1}`, value: token, css: indicatorCssColor(token) }));

const percent = (opacity: number) => Math.round(opacity * 100);

const NUMBER_INPUT =
  "ui-field w-24 disabled:opacity-50";

export function useValidator(): Validate | "loading" | "failed" {
  const [validate, setValidate] = useState<Validate | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    loadValidator().then(
      (v) => live && setValidate(() => v),
      (e: unknown) => {
        console.error("지표 검사기를 불러오지 못했습니다", e);
        if (live) setValidate("failed");
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return validate;
}

export function IndicatorSettingsForm({ draft, color, errors, onChange, lineSample = true, foldColors = false, colorControl = "table" }: {
  draft: Draft;
  color: IndicatorColor;
  errors: readonly FieldError[];
  onChange(draft: Draft): void;
  lineSample?: boolean;
  foldColors?: boolean;
  colorControl?: "table" | "popover";
}) {
  const ids = useId();
  const more = useColorMore();
  const kind = draft.form.kind;
  const placed = placeErrors(kind, errors);
  const setText = (key: string, value: string) => onChange({ ...draft, form: { ...draft.form, text: { ...draft.form.text, [key]: value } } });
  const setEnabled = (key: string, on: boolean) => onChange({ ...draft, form: { ...draft.form, enabled: { ...draft.form.enabled, [key]: on } } });
  const lined = hasColor(draft.form);
  const notice = indicatorPeriodNotice(kind);
  const css = indicatorCssColor(color);
  const usePopover = colorControl === "popover";
  return <div className="@container flex flex-col gap-4">
    {notice && <p className="text-xs text-text-3">{notice}</p>}
    {lined && lineSample && <svg role="img" aria-label="선 미리보기" className="h-[60px] w-full flex-none rounded-m bg-chart-bg shadow-[inset_0_0_0_1px_var(--line)]" viewBox="0 0 636 60" preserveAspectRatio="none" fill="none">
      <path d="M0 44 C 50 42, 80 18, 140 24 S 230 48, 290 38 S 390 8, 450 16 S 560 34, 636 12" stroke={css} strokeWidth={draft.width} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>}
    <div className={lined && !usePopover ? "grid gap-5 @min-[600px]:grid-cols-[minmax(0,1fr)_320px]" : "flex flex-col gap-3"}>
      <section aria-labelledby={`${ids}-values`} className={usePopover ? "ic-card" : "flex min-w-0 flex-col gap-3"}>
        <h4 id={`${ids}-values`} className={usePopover ? "ic-card-title" : "text-xs text-text-3"}>설정값</h4>
        {KINDS[kind].fields.length === 0 && <p className="text-s text-text-3">정할 값이 없는 지표입니다.</p>}
        {kind === "ichimoku" && (
          <Row label="기간 프리셋">
            <span role="group" aria-label="일목균형표 기간 프리셋" className="flex flex-wrap items-center gap-1.5">
              {ICHIMOKU_PERIOD_PRESETS.map((preset) => {
                const active =
                  draft.form.text.conversion === preset.conversion
                  && draft.form.text.base === preset.base
                  && draft.form.text.spanB === preset.spanB
                  && draft.form.text.displacement === preset.displacement;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    className="h-7 rounded-s border border-line bg-bg px-2.5 text-xs text-text-2 hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-ink"
                    onClick={() => onChange({
                      ...draft,
                      form: {
                        ...draft.form,
                        text: {
                          ...draft.form.text,
                          conversion: preset.conversion,
                          base: preset.base,
                          spanB: preset.spanB,
                          displacement: preset.displacement,
                        },
                      },
                    })}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </span>
          </Row>
        )}
        {KINDS[kind].fields.map((f) => {
          const errors = placed.byField[f.key] ?? [];
          const inputId = `${ids}-${f.key}`;
          const errorId = `${inputId}-error`;
          const text = draft.form.text[f.key] ?? "";
          if (f.type === "method") {
            return (
              <Row key={f.key} label={f.label}>
                <Segment label={f.label} options={METHODS} value={text} onChange={(v) => setText(f.key, v)} />
                <Errors id={errorId} messages={errors} />
              </Row>
            );
          }
          if (f.type === "choice") {
            return (
              <Row key={f.key} label={f.label}>
                <Segment label={f.label} options={f.options} value={text} onChange={(v) => setText(f.key, v)} />
                <Errors id={errorId} messages={errors} />
              </Row>
            );
          }
          if (f.type === "flag") {
            const checked = text === "true";
            const lockLastTier =
              kind === "tickCvd"
              && checked
              && KINDS.tickCvd.fields.filter((field) => draft.form.text[field.key] === "true").length <= 1;
            return (
              <Row key={f.key} label={f.label}>
                <button type="button" role="switch" aria-label={f.label} aria-checked={checked} disabled={lockLastTier} className="ui-switch min-h-[var(--size-30)] text-s disabled:opacity-50" onClick={() => setText(f.key, checked ? "false" : "true")}>
                  <span className="flex-1 text-left">{checked ? "켜짐" : "꺼짐"}</span>
                  <span aria-hidden="true" className="ui-switch-track"><span /></span>
                </button>
                <Errors id={errorId} messages={errors} />
              </Row>
            );
          }
          if (f.type === "percent") {
            const pct = Number(text) || f.min;
            return (
              <Row key={f.key} label={f.label} labelFor={inputId}>
                <span className="flex min-h-[30px] min-w-0 items-center gap-2">
                  <input id={inputId} type="range" min={f.min} max={f.max} step={f.step} value={pct} aria-valuetext={`${pct}%`} className="min-w-0 flex-1 accent-[var(--accent)]" onChange={(e) => setText(f.key, e.target.value)} />
                  <output htmlFor={inputId} className="w-10 flex-none text-right text-s tabular-nums text-text-2">{pct}%</output>
                </span>
                <Errors id={errorId} messages={errors} />
              </Row>
            );
          }
          if (f.type === "color") {
            const theme: readonly ThemeSwatch<"">[] = [{ name: "테마 색", value: "", css: f.token === "down" ? "var(--down)" : "var(--up)" }];
            const current: HexColor | "" = isHexColor(text) ? text : "";
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <ColorTable label={f.label} value={current} theme={theme} more={more} onChange={(next) => setText(f.key, next)} />
                <Errors id={errorId} messages={errors} />
              </div>
            );
          }
          const on = f.type !== "optionalInt" || draft.form.enabled[f.key] === true;
          return (
            <Row key={f.key} label={f.label} labelFor={inputId}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {f.type === "optionalInt" && (
                  <button type="button" role="switch" aria-checked={on} className="ui-switch min-h-[var(--size-30)] text-s" onClick={() => setEnabled(f.key, !on)}>
                    <span className="flex-1 text-left">{f.toggle}</span>
                    <span aria-hidden="true" className="ui-switch-track"><span /></span>
                  </button>
                )}
                {!usePopover && kind === "ma" && f.key === "period" && <span role="group" aria-label="자주 쓰는 기간" className="flex items-center gap-1">
                  {PERIOD_PRESETS.map((preset) => <button key={preset} type="button" aria-pressed={text === preset} className="h-6 rounded-s border border-line bg-bg px-2 text-xs text-text-2 hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-ink" onClick={() => setText(f.key, preset)}>{preset}</button>)}
                </span>}
                <span className="flex items-center gap-1.5">
                  <input
                    id={inputId}
                    type="text"
                    inputMode={f.type === "float" ? "decimal" : "numeric"}
                    value={text}
                    disabled={!on}
                    onChange={(e) => setText(f.key, e.target.value)}
                    aria-invalid={errors.length > 0}
                    aria-describedby={errors.length > 0 ? errorId : undefined}
                    autoComplete="off"
                    className={NUMBER_INPUT}
                  />
                  {"unit" in f && f.unit && <span className="text-s text-text-3">{f.unit}</span>}
                </span>
              </span>
              <Errors id={errorId} messages={errors} />
            </Row>
          );
        })}
        {canOverlayPrice(kind) && <Row label="패널">
          <button type="button" role="switch" aria-checked={draft.placement === "price"} aria-describedby={`${ids}-overlay`} className="ui-switch min-h-[30px] text-s" onClick={() => onChange({ ...draft, placement: draft.placement === "price" ? "panel" : "price" })}>
            <span className="flex-1 text-left">가격 패널에 겹치기</span>
            <span aria-hidden="true" className="ui-switch-track"><span /></span>
          </button>
          <p id={`${ids}-overlay`} className="text-xs text-text-3">거래량을 봉 아래쪽에 겹쳐 그립니다. 끄면 별도 패널</p>
        </Row>}
        {hasBarOpacity(kind) && <Row label="막대 불투명도" labelFor={`${ids}-opacity`}>
          <span className="flex min-h-[30px] min-w-0 items-center gap-2">
            <input id={`${ids}-opacity`} type="range" min={BAR_OPACITY_MIN * 100} max={BAR_OPACITY_MAX * 100} step={1} value={percent(draft.barOpacity)} aria-valuetext={`${percent(draft.barOpacity)}%`} className="min-w-0 flex-1 accent-[var(--accent)]" onChange={(e) => onChange({ ...draft, barOpacity: Number(e.target.value) / 100 })} />
            <output htmlFor={`${ids}-opacity`} className="w-10 flex-none text-right text-s tabular-nums text-text-2">{percent(draft.barOpacity)}%</output>
          </span>
        </Row>}
        {kind === "ichimoku" && (() => {
          const ichi = draft.ichimoku ?? DEFAULT_ICHIMOKU_STYLE;
          const minimal = ichi.showCloud && !ichi.showConversion && !ichi.showBase && !ichi.showLagging;
          return <>
          <Row label="보기 프리셋">
            <span role="group" aria-label="일목균형표 보기 모드" className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-pressed={!minimal}
                className="h-7 rounded-s border border-line bg-bg px-2.5 text-xs text-text-2 hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-ink"
                onClick={() => onChange({ ...draft, ichimoku: { ...ichi, showCloud: true, showConversion: true, showBase: true, showSpanA: true, showSpanB: true, showLagging: true } })}
              >
                전체 보기
              </button>
              <button
                type="button"
                aria-pressed={minimal}
                className="h-7 rounded-s border border-line bg-bg px-2.5 text-xs text-text-2 hover:text-text aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-accent-ink"
                onClick={() => onChange({ ...draft, ichimoku: { ...ichi, showCloud: true, showConversion: false, showBase: false, showSpanA: true, showSpanB: true, showLagging: false } })}
              >
                구름대만 보기
              </button>
            </span>
          </Row>
          <Row label="구름대 불투명도" labelFor={`${ids}-cloud-opacity`}>
            <span className="flex min-h-[30px] min-w-0 items-center gap-2">
              <input
                id={`${ids}-cloud-opacity`}
                type="range"
                min={Math.round(ICHIMOKU_CLOUD_OPACITY_MIN * 100)}
                max={Math.round(ICHIMOKU_CLOUD_OPACITY_MAX * 100)}
                step={1}
                value={percent(ichi.cloudOpacity)}
                aria-valuetext={`${percent(ichi.cloudOpacity)}%`}
                className="min-w-0 flex-1 accent-[var(--accent)]"
                onChange={(e) => onChange({ ...draft, ichimoku: { ...ichi, cloudOpacity: Number(e.target.value) / 100 } })}
              />
              <output htmlFor={`${ids}-cloud-opacity`} className="w-10 flex-none text-right text-s tabular-nums text-text-2">{percent(ichi.cloudOpacity)}%</output>
            </span>
          </Row>
          <Row label="표시 요소">
            <div className="grid grid-cols-2 gap-1.5">
              {ICHIMOKU_TOGGLES.map(([key, label]) => {
                const checked = ichi[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="switch"
                    aria-label={label}
                    aria-checked={checked}
                    className="ui-switch min-h-[var(--size-30)] text-s"
                    onClick={() => onChange({ ...draft, ichimoku: { ...ichi, [key]: !checked } })}
                  >
                    <span className="flex-1 text-left">{label}</span>
                    <span aria-hidden="true" className="ui-switch-track"><span /></span>
                  </button>
                );
              })}
            </div>
          </Row>
        </>;
        })()}
      </section>
      {lined && (usePopover ? (
        <section aria-labelledby={`${ids}-line`} className="ic-card">
          <div className="ic-card-head">
            <h4 id={`${ids}-line`} className="ic-card-title">선 스타일</h4>
            <span className="text-xs text-text-3">색상 · 굵기 선택</span>
          </div>
          <Row label="색상 · 굵기">
            <ColorStyleTrigger
              label="선 색"
              value={color}
              theme={THEME_SWATCHES}
              width={draft.width}
              size="lg"
              opacity={hasBarOpacity(kind) ? { value: draft.barOpacity, min: BAR_OPACITY_MIN, max: BAR_OPACITY_MAX, onChange: (barOpacity) => onChange({ ...draft, barOpacity }) } : undefined}
              onColorChange={(next) => onChange({ ...draft, color: next })}
              onWidthChange={(width) => onChange({ ...draft, width })}
            />
          </Row>
        </section>
      ) : (
        <section aria-labelledby={`${ids}-line`} className="flex min-w-0 flex-col gap-3">
          <h4 id={`${ids}-line`} className="text-xs text-text-3">선</h4>
          <Row label="선 굵기">
            <div role="group" aria-label="굵기" className="grid w-full grid-cols-5 gap-1">
              {WIDTHS.map(([width, name]) => <button key={width} type="button" aria-label={name} aria-pressed={draft.width === width} className="grid h-7 place-items-center rounded-m bg-[var(--hover)] aria-pressed:bg-accent-soft aria-pressed:shadow-[inset_0_0_0_1px_var(--accent)]" onClick={() => onChange({ ...draft, width })}>
                <i className="w-6 rounded-full" style={{ height: width, background: css }} />
              </button>)}
            </div>
          </Row>
          <ColorTable label="선 색" value={color} theme={THEME_SWATCHES} width={draft.width} more={foldColors ? more : undefined} onChange={(next) => onChange({ ...draft, color: next })} />
        </section>
      ))}
    </div>
  </div>;
}
