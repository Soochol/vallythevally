import type { IndicatorSpec } from "../../chart/indicators/kinds";
import {
  firstUnusedColor,
  type IndicatorColor,
  type IndicatorKind,
  isFinancial,
  isMicro,
  isQuote,
  KINDS,
  colorLine,
  type Placement,
  placementsOf,
  type Validate,
  shownColor,
  specName,
} from "../../chart/indicators/kinds";
import { barOpacityOf, DEFAULT_BAR_OPACITY, DEFAULT_ICHIMOKU_STYLE, ichimokuStyleOf, type IchimokuStyle, type IndicatorConfig, type LineWidth, type Panel, placementOfConfig, readSpecShape } from "../../chart/settings";
import { normalizeHex } from "../../lib/colors";

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
  placement: Placement;
  barOpacity: number;
  ichimoku?: IchimokuStyle;
}

export const canOverlayPrice = (kind: IndicatorKind): boolean => placementsOf(kind).includes("price") && placementsOf(kind).includes("panel");
export const hasBarOpacity = (kind: IndicatorKind): boolean => kind === "volume";

export function draftStyle(draft: Draft, colors: IndicatorColor[]): IndicatorConfig["style"] {
  return {
    colors,
    width: draft.width,
    ...(hasBarOpacity(draft.form.kind) ? { barOpacity: draft.barOpacity } : {}),
    ...(draft.form.kind === "ichimoku" ? { ichimoku: draft.ichimoku ?? DEFAULT_ICHIMOKU_STYLE } : {}),
  };
}

export function formFromSpec(spec: IndicatorSpec): SpecForm {
  const values: Record<string, unknown> = { ...spec };
  const defaults: Record<string, unknown> = { ...KINDS[spec.kind].defaults };
  const text: Record<string, string> = {};
  const enabled: Record<string, boolean> = {};
  for (const f of KINDS[spec.kind].fields) {
    const v = values[f.key] === undefined ? defaults[f.key] : values[f.key];
    if (f.type === "optionalInt") {
      enabled[f.key] = v !== null;
      text[f.key] = String(v ?? defaults[f.key] ?? f.start);
    } else if (f.type === "percent") {
      text[f.key] = String(Math.round(Number(v) * 100));
    } else if (f.type === "flag") {
      text[f.key] = v ? "true" : "false";
    } else if (f.type === "color") {
      text[f.key] = v === null ? "" : String(v);
    } else {
      text[f.key] = String(v);
    }
  }
  return { kind: spec.kind, text, enabled };
}

export function startDraft(editing: IndicatorConfig | null, kind: IndicatorKind): Draft {
  if (editing) {
    return {
      form: formFromSpec(editing.spec),
      color: shownColor(editing.spec, editing.style.colors),
      width: editing.style.width,
      placement: placementOfConfig(editing),
      barOpacity: barOpacityOf(editing.style),
      ...(editing.spec.kind === "ichimoku" ? { ichimoku: { ...ichimokuStyleOf(editing.style) } } : {}),
    };
  }
  return {
    form: formFromSpec(KINDS[kind].defaults),
    color: "auto",
    width: 1,
    placement: KINDS[kind].place,
    barOpacity: DEFAULT_BAR_OPACITY,
    ...(kind === "ichimoku" ? { ichimoku: { ...DEFAULT_ICHIMOKU_STYLE } } : {}),
  };
}

const INT = /^\d+$/;

function readForm(form: SpecForm): { spec: IndicatorSpec | null; errors: FieldError[] } {
  const raw: Record<string, unknown> = { kind: form.kind };
  const errors: FieldError[] = [];
  for (const f of KINDS[form.kind].fields) {
    const t = (form.text[f.key] ?? "").trim();
    if (f.type === "method" || f.type === "choice") raw[f.key] = t;
    else if (f.type === "flag") {
      if (t === "true" || t === "false") raw[f.key] = t === "true";
      else errors.push({ field: f.key, message: "켜짐 또는 꺼짐이어야 합니다." });
    } else if (f.type === "percent") {
      const n = INT.test(t) ? Number(t) : Number.NaN;
      if (Number.isFinite(n) && n >= f.min && n <= f.max) raw[f.key] = n / 100;
      else errors.push({ field: f.key, message: `${f.min}~${f.max}% 사이여야 합니다.` });
    } else if (f.type === "color") {
      if (t === "") raw[f.key] = null;
      else {
        const hex = normalizeHex(t);
        if (hex) raw[f.key] = hex;
        else errors.push({ field: f.key, message: "올바른 색상이어야 합니다." });
      }
    } else if (f.type === "optionalInt" && !form.enabled[f.key]) raw[f.key] = null;
    else if (f.type === "float") {
      const n = Number(t);
      if (t !== "" && Number.isFinite(n)) raw[f.key] = n;
      else errors.push({ field: f.key, message: "숫자여야 합니다." });
    } else if (INT.test(t)) {
      const n = Number(t);
      if (f.type === "optionalInt" && f.max !== undefined && (n < 1 || n > f.max)) {
        errors.push({ field: f.key, message: `1~${f.max} 사이의 정수여야 합니다.` });
      } else raw[f.key] = n;
    } else errors.push({ field: f.key, message: "1 이상의 정수여야 합니다." });
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

export function primaryLabel(editing: boolean, kind: IndicatorKind, spec: IndicatorSpec | null): string {
  if (editing) return "변경 적용";
  return `${spec ? specName(spec) : KINDS[kind].label} 추가`;
}

export function panelLabel(panels: readonly Panel[], panel: IndicatorConfig["panel"]): string {
  return panel === "price" ? "가격 패널" : `지표 패널 ${panels.findIndex((p) => p.id === panel) + 1}`;
}

export function indicatorPeriodNotice(kind: IndicatorKind): string | null {
  const spec = KINDS[kind].defaults;
  if (isFinancial(spec)) return "분기봉·연봉의 보고기간별 자료입니다. DPS는 연간 전용이며 다른 봉 주기에서는 설정을 보존하고 숨깁니다.";
  if (isQuote(spec)) return "주식·ETF 분봉의 호가 자료입니다. 일봉 이상이나 지수에서는 설정을 보존하고 숨깁니다.";
  if (isMicro(spec)) return "주식·ETF 분봉의 체결·프로그램 수급 자료입니다. 일봉 이상이나 지수에서는 안내 문구만 보입니다.";
  return null;
}
