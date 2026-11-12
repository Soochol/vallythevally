import type { IndicatorSpec } from "../../chart/indicators/kinds";
import {
  firstUnusedColor,
  type IndicatorColor,
  type IndicatorKind,
  KIND_ORDER,
  KINDS,
  type Placement,
  colorLine,
  type Validate,
  shownColor,
  specName,
} from "../../chart/indicators/kinds";
import { type IndicatorConfig, type LineWidth, type Panel, readSpecShape } from "../../chart/settings";
import { highlight, normalizeQuery } from "../search/highlight";

export type { Validate };
export interface FieldError {
  field: string;
  message: string;
}

export interface SpecForm {
  kind: IndicatorKind;
  text: Record<string, string>;
  enabled: Record<string, boolean>;
}

export interface Draft {
  form: SpecForm;
  color: IndicatorColor | "auto";
  width: LineWidth;
}


export const KIND_GROUPS: { place: Placement; financial: boolean; label: string }[] = [
  { place: "price", financial: false, label: "기술지표 · 가격 패널에 겹쳐 그림" },
  { place: "panel", financial: false, label: "기술지표 · 아래 지표 패널에 그림" },
  { place: "panel", financial: true, label: "재무지표 · 분기봉·연봉" },
];

export function formFromSpec(spec: IndicatorSpec): SpecForm {
  const values: Record<string, unknown> = { ...spec };
  const defaults: Record<string, unknown> = { ...KINDS[spec.kind].defaults };
  const text: Record<string, string> = {};
  const enabled: Record<string, boolean> = {};
  for (const f of KINDS[spec.kind].fields) {
    const v = values[f.key];
    if (f.type === "optionalInt") {
      enabled[f.key] = v !== null;
      text[f.key] = String(v ?? defaults[f.key] ?? f.start);
    } else {
      text[f.key] = String(v);
    }
  }
  return { kind: spec.kind, text, enabled };
}

export function startDraft(editing: IndicatorConfig | null, kind: IndicatorKind): Draft {
  if (editing) {
    return { form: formFromSpec(editing.spec), color: shownColor(editing.spec, editing.style.colors), width: editing.style.width };
  }
  return { form: formFromSpec(KINDS[kind].defaults), color: "auto", width: 1 };
}

const INT = /^\d+$/;

function readForm(form: SpecForm): { spec: IndicatorSpec | null; errors: FieldError[] } {
  const raw: Record<string, unknown> = { kind: form.kind };
  const errors: FieldError[] = [];
  for (const f of KINDS[form.kind].fields) {
    const t = (form.text[f.key] ?? "").trim();
    if (f.type === "method") raw[f.key] = t;
    else if (f.type === "optionalInt" && !form.enabled[f.key]) raw[f.key] = null;
    else if (f.type === "float") {
      const n = Number(t);
      if (t !== "" && Number.isFinite(n)) raw[f.key] = n;
      else errors.push({ field: f.key, message: "숫자여야 합니다." });
    } else if (INT.test(t)) raw[f.key] = Number(t);
    else errors.push({ field: f.key, message: "1 이상의 정수여야 합니다." });
  }
  if (errors.length) return { spec: null, errors };
  const spec = readSpecShape(raw);
  return spec ? { spec, errors } : { spec: null, errors: [{ field: "", message: "지표 설정을 읽을 수 없습니다." }] };
}

export type FormCheck =
  | { ok: true; spec: IndicatorSpec; errors: [] }
  | { ok: false; spec: IndicatorSpec | null; errors: FieldError[] };

export function checkForm(form: SpecForm, validate: Validate | null): FormCheck {
  const { spec, errors } = readForm(form);
  if (!spec) return { ok: false, spec, errors };
  if (!validate) return { ok: false, spec, errors: [] };
  const result = validate(spec);
  return result.ok ? { ok: true, spec, errors: [] } : { ok: false, spec, errors: result.errors };
}

export function placeErrors(kind: IndicatorKind, errors: readonly FieldError[]): { byField: Record<string, string[]>; rest: string[] } {
  const keys = new Set(KINDS[kind].fields.map((f) => f.key));
  const byField: Record<string, string[]> = {};
  const rest: string[] = [];
  for (const e of errors) {
    if (keys.has(e.field)) (byField[e.field] ??= []).push(e.message);
    else rest.push(e.message);
  }
  return { byField, rest };
}

export function hasColor(form: SpecForm): boolean {
  const shape: Record<string, unknown> = { ...KINDS[form.kind].defaults };
  for (const f of KINDS[form.kind].fields) if (f.type === "optionalInt") shape[f.key] = form.enabled[f.key] ? 1 : null;
  const spec = readSpecShape(shape);
  return spec !== null && colorLine(spec) !== null;
}

export function nextColor(indicators: readonly IndicatorConfig[]): IndicatorColor {
  return firstUnusedColor(indicators.map((i) => shownColor(i.spec, i.style.colors)));
}

export function matchKinds(query: string): IndicatorKind[] {
  const q = normalizeQuery(query);
  return KIND_ORDER.filter((k) => q === "" || highlight(KINDS[k].label, q).some((s) => s.match));
}

export function primaryLabel(editing: boolean, kind: IndicatorKind, spec: IndicatorSpec | null): string {
  if (editing) return "변경 적용";
  return `${spec ? specName(spec) : KINDS[kind].label} 추가`;
}

export function panelLabel(panels: readonly Panel[], panel: IndicatorConfig["panel"]): string {
  return panel === "price" ? "가격 패널" : `지표 패널 ${panels.findIndex((p) => p.id === panel) + 1}`;
}
