import type { BarField } from "../../api/generated/BarField";
import type { ExcludeKind } from "../../api/generated/ExcludeKind";
import type { NewHigh } from "../../api/generated/NewHigh";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import { excludedInOrder, UNIT } from "../../lib/screener";

const MAX_SCREENS = 50;
const MAX_SCREEN_NAME = 40;
export const MAX_CONDITIONS = 10;
const MAX_BARS = 4_294_967_295;

export interface ConditionDraft {
  key: number;
  field: BarField;
  n: string;
  m: string;
}

export interface ScreenDraft {
  name: string;
  period: ScreenPeriod;
  conditions: readonly ConditionDraft[];
  exclude: readonly ExcludeKind[];
}

export interface ConditionErrors {
  n: string | null;
  m: string | null;
}

export type ConditionCheck = { ok: true; condition: NewHigh } | { ok: false; errors: ConditionErrors };

export interface DraftErrors {
  name: string | null;
  list: string | null;
}

export type DraftCheck = { ok: true; screen: Screen } | { ok: false; errors: DraftErrors };

export type ExcludeGroup = "kind" | "status";
const EXCLUDE_GROUP: Record<ExcludeKind, ExcludeGroup> = {
  etf: "kind",
  preferred: "kind",
  reit: "kind",
  spac: "kind",
  managed: "status",
  investment_caution_alert: "status",
  investment_warning: "status",
  investment_danger: "status",
  investment_caution: "status",
  short_term_overheated: "status",
  trading_halted: "status",
};
export const excludesIn = (group: ExcludeGroup): ExcludeKind[] => excludedInOrder(Object.keys(EXCLUDE_GROUP) as ExcludeKind[]).filter((k) => EXCLUDE_GROUP[k] === group);

const NEW_CONDITION: Omit<ConditionDraft, "key"> = { field: "high", n: "200", m: "1" };

export function draftOf(screen: Screen | null): ScreenDraft {
  if (!screen) return { name: "", period: "D", conditions: [{ key: 0, ...NEW_CONDITION }], exclude: [] };
  return {
    name: screen.name,
    period: screen.period,
    conditions: screen.conditions.map((c, key) => ({ key, field: c.field, n: String(c.n), m: String(c.m) })),
    exclude: screen.exclude,
  };
}

export function addCondition(draft: ScreenDraft): ScreenDraft {
  if (draft.conditions.length >= MAX_CONDITIONS) return draft;
  const key = Math.max(-1, ...draft.conditions.map((c) => c.key)) + 1;
  return { ...draft, conditions: [...draft.conditions, { ...NEW_CONDITION, ...draft.conditions.at(-1), key }] };
}

export function removeCondition(draft: ScreenDraft, key: number): ScreenDraft {
  if (draft.conditions.length <= 1) return draft;
  return { ...draft, conditions: draft.conditions.filter((c) => c.key !== key) };
}

export function editCondition(draft: ScreenDraft, key: number, patch: Partial<Omit<ConditionDraft, "key">>): ScreenDraft {
  return { ...draft, conditions: draft.conditions.map((c) => (c.key === key ? { ...c, ...patch } : c)) };
}

export function toggleExclude(draft: ScreenDraft, kind: ExcludeKind): ScreenDraft {
  const exclude = draft.exclude.includes(kind) ? draft.exclude.filter((k) => k !== kind) : [...draft.exclude, kind];
  return { ...draft, exclude: excludedInOrder(exclude) };
}

const count = (n: number) => n.toLocaleString("ko-KR");
const BAR_COUNT = /^(\d+|\d{1,3}(,\d{3})+)$/;

type CountRead = { ok: true; value: number } | { ok: false; error: string };

function readCount(text: string): CountRead {
  const trimmed = text.trim();
  const value = BAR_COUNT.test(trimmed) ? Number(trimmed.replaceAll(",", "")) : 0;
  if (value < 1) return { ok: false, error: "1 이상의 정수를 넣으세요" };
  if (value > MAX_BARS) return { ok: false, error: `${count(MAX_BARS)} 이하로 넣으세요` };
  return { ok: true, value };
}

function checkName(name: string): string | null {
  const length = [...name.trim()].length;
  if (length === 0) return "이름을 넣으세요";
  if (length > MAX_SCREEN_NAME) return `이름은 ${MAX_SCREEN_NAME}자까지입니다 (지금 ${length}자)`;
  return null;
}

export function checkCondition({ field, n: nText, m: mText }: ConditionDraft, period: ScreenPeriod): ConditionCheck {
  const n = readCount(nText);
  const m = readCount(mText);
  const mError = !m.ok ? m.error : n.ok && m.value > n.value ? `신고가 기간 ${count(n.value)}${UNIT[period]}보다 길 수 없습니다` : null;
  if (n.ok && m.ok && mError === null) return { ok: true, condition: { field, n: n.value, m: m.value } };
  return { ok: false, errors: { n: n.ok ? null : n.error, m: mError } };
}

export function checkDraft(draft: ScreenDraft, id: string, saved: readonly Screen[]): DraftCheck {
  const name = checkName(draft.name);
  const list = !saved.some((s) => s.id === id) && saved.length >= MAX_SCREENS ? `조건식은 ${MAX_SCREENS}개까지 저장할 수 있습니다. 하나를 지운 뒤 만드세요.` : null;
  const conditions = draft.conditions.flatMap((c) => {
    const row = checkCondition(c, draft.period);
    return row.ok ? [row.condition] : [];
  });
  if (name === null && list === null && conditions.length === draft.conditions.length) {
    return { ok: true, screen: { id, name: draft.name.trim(), period: draft.period, exclude: [...draft.exclude], conditions } };
  }
  return { ok: false, errors: { name, list } };
}

export function withScreen(saved: readonly Screen[], screen: Screen): Screen[] {
  return saved.some((s) => s.id === screen.id) ? saved.map((s) => (s.id === screen.id ? screen : s)) : [...saved, screen];
}
