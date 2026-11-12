import { useEffect, useId, useState } from "react";
import type { MaMethod } from "../../api/generated/MaMethod";
import { indicatorCssColor, KINDS, type IndicatorColor } from "../../chart/indicators/kinds";
import { loadValidator } from "../../chart/indicators/validate";
import type { LineWidth } from "../../chart/settings";
import { Errors, Row, Segment } from "../dialog/DialogParts";
import { ColorPicker } from "../color/ColorPicker";
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
        <Row label="선 색상"><ColorPicker label="선 색상" value={indicatorCssColor(color)} width={draft.width} onChange={(color) => onChange({ ...draft, color })} /></Row>
        <Row label="선 굵기">
          <Segment label="굵기" options={WIDTHS} value={draft.width} onChange={(width) => onChange({ ...draft, width })} />
        </Row>
      </>
    )}
  </>;
}
