import type { IndicatorSpec } from "../../api/generated/IndicatorSpec";
import {
  firstUnusedColor,
  type IndicatorColor,
  type IndicatorKind,
  KIND_ORDER,
  KINDS,
  type Placement,
  primaryLine,
  type Validate,
  shownColor,
  specName,
} from "../../chart/indicators/kinds";
import { type IndicatorConfig, type LineWidth, type Panel, readSpec } from "../../chart/settings";
import { highlight, normalizeQuery } from "../search/highlight";

export type { Validate };
export interface FieldError {
  field: string;
  message: string;
}

/** 지표 설정 입력. 숫자 칸은 친 글자 그대로 둔다(지운 칸도 나타내야 한다). method 칸은 "sma" | "ema". */
export interface SpecForm {
  kind: IndicatorKind;
  text: Record<string, string>;
  /** optionalInt 칸을 켰는지. */
  on: Record<string, boolean>;
}

/** 대화상자 오른쪽 설정 전체. color가 null이면 이 칸에서 아직 쓰지 않은 첫 색을 쓴다. */
export interface Draft {
  form: SpecForm;
  color: IndicatorColor | null;
  width: LineWidth;
}

/** 기본값이 null인 칸(RSI 시그널)을 켰을 때 처음 보이는 값. MACD 시그널 기본값과 같다. */
const OPTIONAL_START = 9;

export const KIND_GROUPS: { place: Placement; label: string }[] = [
  { place: "price", label: "가격 패널에 겹쳐 그림" },
  { place: "panel", label: "아래 지표 패널에 그림" },
];

export function formFromSpec(spec: IndicatorSpec): SpecForm {
  const values: Record<string, unknown> = { ...spec };
  const defaults: Record<string, unknown> = { ...KINDS[spec.kind].defaults };
  const text: Record<string, string> = {};
  const on: Record<string, boolean> = {};
  for (const f of KINDS[spec.kind].fields) {
    const v = values[f.key];
    if (f.type === "optionalInt") {
      on[f.key] = v !== null;
      text[f.key] = String(v ?? defaults[f.key] ?? OPTIONAL_START);
    } else {
      text[f.key] = String(v);
    }
  }
  return { kind: spec.kind, text, on };
}

export function startDraft(editing: IndicatorConfig | null, kind: IndicatorKind): Draft {
  if (editing) {
    return { form: formFromSpec(editing.spec), color: shownColor(editing.spec, editing.style.colors), width: editing.style.width };
  }
  return { form: formFromSpec(KINDS[kind].defaults), color: null, width: 1 };
}

const INT = /^\d+$/;

function readForm(form: SpecForm): { spec: IndicatorSpec | null; errors: FieldError[] } {
  const raw: Record<string, unknown> = { kind: form.kind };
  const errors: FieldError[] = [];
  for (const f of KINDS[form.kind].fields) {
    const t = (form.text[f.key] ?? "").trim();
    if (f.type === "method") raw[f.key] = t;
    else if (f.type === "optionalInt" && !form.on[f.key]) raw[f.key] = null;
    else if (f.type === "float") {
      const n = Number(t);
      if (t !== "" && Number.isFinite(n)) raw[f.key] = n;
      else errors.push({ field: f.key, message: "숫자여야 합니다." });
    } else if (INT.test(t)) raw[f.key] = Number(t);
    else errors.push({ field: f.key, message: "1 이상의 정수여야 합니다." });
  }
  if (errors.length) return { spec: null, errors };
  const spec = readSpec(raw);
  return spec ? { spec, errors } : { spec: null, errors: [{ field: "", message: "지표 설정을 읽을 수 없습니다." }] };
}

export type FormCheck =
  | { ok: true; spec: IndicatorSpec; errors: [] }
  | { ok: false; spec: IndicatorSpec | null; errors: FieldError[] };

/**
 * 글자를 스펙으로 읽고 wasm 검사(D6)를 거친다. 정수 칸의 소수·빈칸은 여기서 막는다.
 * validate가 아직 없으면(wasm을 불러오는 중) 통과시키지 않는다.
 */
export function checkForm(form: SpecForm, validate: Validate | null): FormCheck {
  const { spec, errors } = readForm(form);
  if (!spec) return { ok: false, spec, errors };
  if (!validate) return { ok: false, spec, errors: [] };
  const result = validate(spec);
  return result.ok ? { ok: true, spec, errors: [] } : { ok: false, spec, errors: result.errors };
}

/** 입력칸 key가 맞는 오류는 그 칸 아래에, 나머지는 설정 묶음 맨 아래에 적는다. */
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

/** 색을 고를 선이 있는지. 선은 optionalInt를 켰는지에만 달려 있어, 숫자를 잘못 쳐도 정할 수 있다. */
export function hasColor(form: SpecForm): boolean {
  const shape: Record<string, unknown> = { ...KINDS[form.kind].defaults };
  for (const f of KINDS[form.kind].fields) if (f.type === "optionalInt") shape[f.key] = form.on[f.key] ? 1 : null;
  const spec = readSpec(shape);
  return spec !== null && primaryLine(spec) !== null;
}

/** 이 칸에서 아직 쓰지 않은 첫 색(frontend.md §3.3). */
export function nextColor(indicators: readonly IndicatorConfig[]): IndicatorColor {
  return firstUnusedColor(indicators.map((i) => shownColor(i.spec, i.style.colors)));
}

/** 이름과 초성으로 찾는다(종목 검색과 같은 정규화). */
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
