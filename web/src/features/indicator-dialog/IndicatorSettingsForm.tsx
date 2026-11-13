import { useEffect, useId, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { indicatorCssColor, KINDS, type IndicatorColor } from "../../chart/indicators/kinds";
import { loadValidator } from "../../chart/indicators/validate";
import type { LineWidth } from "../../chart/settings";
import { Errors, Row, Segment } from "../dialog/DialogParts";
import { ColorPicker, readRecent, rememberColor, resolvedColor } from "../color/ColorPicker";
import { PRESET_COLORS, type HexColor } from "../../lib/colors";
import { hasColor, placeErrors, type Draft, type FieldError, type Validate } from "./indicatorForm";

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

export function IndicatorSettingsForm({ draft, color, errors, onChange }: {
  draft: Draft;
  color: IndicatorColor;
  errors: readonly FieldError[];
  onChange(draft: Draft): void;
}) {
  const ids = useId();
  const kind = draft.form.kind;
  const placed = placeErrors(kind, errors);
  const setText = (key: string, value: string) => onChange({ ...draft, form: { ...draft.form, text: { ...draft.form.text, [key]: value } } });
  const setEnabled = (key: string, on: boolean) => onChange({ ...draft, form: { ...draft.form, enabled: { ...draft.form.enabled, [key]: on } } });
  return <>
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
      const on = f.type !== "optionalInt" || draft.form.enabled[f.key] === true;
      return (
        <Row key={f.key} label={f.label} labelFor={inputId}>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {f.type === "optionalInt" && (
              <label className="flex items-center gap-1.5 text-s">
                <input type="checkbox" checked={on} onChange={(e) => setEnabled(f.key, e.target.checked)} />
                {f.toggle}
              </label>
            )}
            {kind === "ma" && f.key === "period" && <span role="group" aria-label="자주 쓰는 기간" className="flex items-center gap-1">
              {PERIOD_PRESETS.map((preset) => <button key={preset} type="button" aria-pressed={text === preset} className="h-6 rounded-m bg-[var(--hover)] px-2 text-xs text-text-2 aria-pressed:bg-accent-soft aria-pressed:text-accent" onClick={() => setText(f.key, preset)}>{preset}</button>)}
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
    {hasColor(draft.form) && (
      <>
        <Row label="선 색상">
          <QuickColors current={resolvedColor(indicatorCssColor(color))} onChoose={(next) => { rememberColor(next); onChange({ ...draft, color: next }); }} />
          <ColorPicker label="선 색상" value={indicatorCssColor(color)} width={draft.width} onChange={(color) => onChange({ ...draft, color })} />
        </Row>
        <Row label="선 굵기">
          <div role="group" aria-label="굵기" className="grid w-full max-w-[220px] grid-cols-5 gap-1">
            {WIDTHS.map(([width, name]) => <button key={width} type="button" aria-label={name} aria-pressed={draft.width === width} className="grid h-7 place-items-center rounded-m bg-[var(--hover)] aria-pressed:bg-accent-soft aria-pressed:shadow-[inset_0_0_0_1px_var(--accent)]" onClick={() => onChange({ ...draft, width })}>
              <i className="w-6 rounded-full" style={{ height: width, background: indicatorCssColor(color) }} />
            </button>)}
          </div>
        </Row>
      </>
    )}
  </>;
}

function QuickColors({ current, onChoose }: { current: HexColor; onChoose(color: HexColor): void }) {
  const [recent] = useState(readRecent);
  const swatch = (color: HexColor, name: string) => <button key={`${name}-${color}`} type="button" aria-label={`${name} ${color}`} aria-pressed={color === current} className="h-4 rounded-s aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-offset-1 aria-pressed:outline-text" style={{ background: color }} onClick={() => onChoose(color)} />;
  return <div className="flex w-full max-w-[260px] flex-col gap-1.5">
    <div role="group" aria-label="빠른 색상" className="grid grid-cols-12 gap-1">{PRESET_COLORS.map((color, i) => swatch(color, `빠른 색상 ${i + 1}`))}</div>
    {recent.length > 0 && <div role="group" aria-label="최근 쓴 색상" className="grid grid-cols-12 gap-1">{recent.map((color) => swatch(color, "최근 쓴 색상"))}</div>}
  </div>;
}
