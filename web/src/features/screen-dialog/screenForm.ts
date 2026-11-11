import type { BarField } from "../../api/generated/BarField";
import type { BollingerBand } from "../../api/generated/BollingerBand";
import type { Bound } from "../../api/generated/Bound";
import type { Condition } from "../../api/generated/Condition";
import type { Direction } from "../../api/generated/Direction";
import type { ExcludeKind } from "../../api/generated/ExcludeKind";
import type { Extreme } from "../../api/generated/Extreme";
import type { MaMethod } from "../../api/generated/MaMethod";
import type { MaOrder } from "../../api/generated/MaOrder";
import type { MacdTest } from "../../api/generated/MacdTest";
import type { Market } from "../../api/generated/Market";
import type { PriceField } from "../../api/generated/PriceField";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import type { Side } from "../../api/generated/Side";
import type { SurgeField } from "../../api/generated/SurgeField";
import { KINDS } from "../../chart/indicators/kinds";
import { type ConditionKind, excludedInOrder, NEW_HIGH_NAME, UNIT } from "../../lib/screener";

const MAX_SCREENS = 50;
const MAX_SCREEN_NAME = 40;
export const MAX_CONDITIONS = 10;
const MAX_BARS = 4_294_967_295;
const MAX_INDICATOR_LENGTH = 65_535;
export const MIN_MA_LINES = 2;
export const MAX_MA_LINES = 5;
const EOK_PLACES = 8;

export type CloseOrMa = "close" | "ma";

export type KindFields =
  | { kind: "new_high"; field: BarField; n: string }
  | { kind: "new_low"; field: BarField; n: string }
  | { kind: "value_range"; field: BarField; min: string; max: string }
  | { kind: "change"; back: string; minPct: string; maxPct: string }
  | { kind: "near_extreme"; extreme: Extreme; n: string; withinPct: string }
  | { kind: "surge"; field: SurgeField; n: string; times: string }
  | { kind: "ma_position"; field: PriceField; method: MaMethod; length: string; side: Side }
  | { kind: "ma_alignment"; method: MaMethod; lengths: readonly string[]; order: MaOrder }
  | { kind: "ma_cross"; method: MaMethod; fastLine: CloseOrMa; fast: string; slow: string; direction: Direction }
  | { kind: "rsi"; length: string; test: "range" | "breakout"; min: string; max: string; value: string; direction: Direction }
  | { kind: "macd"; fast: string; slow: string; signal: string; test: MacdTest["kind"]; direction: Direction; side: Side }
  | { kind: "stochastic"; k: string; d: string; smooth: string; test: "cross" | "range"; direction: Direction; min: string; max: string }
  | { kind: "bollinger"; length: string; k: string; test: "outside" | "cross"; side: Side; band: BollingerBand; direction: Direction }
  | { kind: "ichimoku"; conversion: string; base: string; spanB: string; displacement: string; test: "cloud" | "cross"; side: Side; direction: Direction }
  | { kind: "market_cap"; min: string; max: string };

type FieldsOf<K extends ConditionKind> = Extract<KindFields, { kind: K }>;

export type ConditionDraft = { key: number; period: ScreenPeriod; m: string } & KindFields;

export interface ScreenDraft {
  name: string;
  conditions: readonly ConditionDraft[];
  markets: readonly Market[];
  exclude: readonly ExcludeKind[];
}

export type FieldKey =
  | "m"
  | "n"
  | "min"
  | "max"
  | "back"
  | "minPct"
  | "maxPct"
  | "withinPct"
  | "times"
  | "length"
  | `lengths.${number}`
  | "fast"
  | "slow"
  | "signal"
  | "value"
  | "k"
  | "d"
  | "smooth"
  | "conversion"
  | "base"
  | "spanB"
  | "displacement";

export type ConditionErrors = Partial<Record<FieldKey, string>>;

export type ConditionCheck = { ok: true; condition: Condition } | { ok: false; errors: ConditionErrors };

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

export const MARKETS: readonly Market[] = ["kospi", "kosdaq"];

const TRADE_HIGHS = { volume_high: "volume", traded_value_high: "traded_value" } as const satisfies Record<string, BarField>;
type TradeHigh = keyof typeof TRADE_HIGHS;
export type KindChoice = ConditionKind | TradeHigh;
const TRADE_HIGH_START = { period: "D", m: "100", n: "200" } as const;

export const KIND_GROUPS: readonly { label: string; kinds: readonly KindChoice[] }[] = [
  { label: "가격", kinds: ["new_high", "new_low", "value_range", "change", "near_extreme"] },
  { label: "거래", kinds: ["volume_high", "traded_value_high", "surge"] },
  { label: "이동평균", kinds: ["ma_position", "ma_alignment", "ma_cross"] },
  { label: "보조지표", kinds: ["rsi", "macd", "stochastic", "bollinger", "ichimoku"] },
  { label: "종목", kinds: ["market_cap"] },
];

const text = String;
const MA = KINDS.ma.defaults;
const BOLLINGER = KINDS.bollinger.defaults;
const ICHIMOKU = KINDS.ichimoku.defaults;
const RSI = KINDS.rsi.defaults;
const MACD = KINDS.macd.defaults;
const STOCHASTIC = KINDS.stochSlow.defaults;

const DEFAULTS: { [K in ConditionKind]: FieldsOf<K> } = {
  new_high: { kind: "new_high", field: "high", n: "200" },
  new_low: { kind: "new_low", field: "low", n: "200" },
  value_range: { kind: "value_range", field: "traded_value", min: "100", max: "" },
  change: { kind: "change", back: "1", minPct: "5", maxPct: "" },
  near_extreme: { kind: "near_extreme", extreme: "high", n: "200", withinPct: "5" },
  surge: { kind: "surge", field: "volume", n: "20", times: "3" },
  ma_position: { kind: "ma_position", field: "close", method: MA.method, length: text(MA.period), side: "above" },
  ma_alignment: { kind: "ma_alignment", method: MA.method, lengths: ["5", "20", "60", "120"], order: "bullish" },
  ma_cross: { kind: "ma_cross", method: MA.method, fastLine: "ma", fast: "5", slow: text(MA.period), direction: "up" },
  rsi: { kind: "rsi", length: text(RSI.period), test: "range", min: "", max: "30", value: "30", direction: "up" },
  macd: { kind: "macd", fast: text(MACD.fast), slow: text(MACD.slow), signal: text(MACD.signal), test: "signal_cross", direction: "up", side: "above" },
  stochastic: { kind: "stochastic", k: text(STOCHASTIC.k), d: text(STOCHASTIC.d), smooth: text(STOCHASTIC.smooth), test: "cross", direction: "up", min: "", max: "20" },
  bollinger: { kind: "bollinger", length: text(BOLLINGER.period), k: text(BOLLINGER.k), test: "outside", side: "above", band: "upper", direction: "up" },
  ichimoku: {
    kind: "ichimoku",
    conversion: text(ICHIMOKU.conversion),
    base: text(ICHIMOKU.base),
    spanB: text(ICHIMOKU.spanB),
    displacement: text(ICHIMOKU.displacement),
    test: "cloud",
    side: "above",
    direction: "up",
  },
  market_cap: { kind: "market_cap", min: "3000", max: "" },
};

type Decimal = { sign: string; digits: string; point: number };

const SAVED_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;
const TYPED_NUMBER = /^([+\-−]?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;

function decimalOf(match: RegExpExecArray | null): Decimal | null {
  if (!match) return null;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  return { sign: sign === "-" || sign === "−" ? "-" : "", digits: whole.replaceAll(",", "") + fraction, point: whole.replaceAll(",", "").length + Number(exponent) };
}

function plain({ sign, digits, point }: Decimal, places: number): string {
  const at = point + places;
  const padded = at <= 0 ? "0".repeat(1 - at) + digits : digits.padEnd(at, "0");
  const split = Math.max(at, 1);
  const whole = padded.slice(0, split).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(split).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function numberText(value: number, places = 0): string {
  const saved = decimalOf(SAVED_NUMBER.exec(String(value)));
  return saved ? plain(saved, -places) : String(value);
}

function typedNumber(input: string, places: number): number | null {
  const typed = decimalOf(TYPED_NUMBER.exec(input.trim()));
  const value = typed ? Number(plain(typed, places)) : NaN;
  return Number.isFinite(value) ? value : null;
}

const boundText = (bound: Bound, places = 0) => (bound === null ? "" : numberText(bound, places));
const wonPlaces = (field: BarField) => (field === "traded_value" ? EOK_PLACES : 0);

function fieldsOf(condition: Condition): KindFields {
  switch (condition.kind) {
    case "new_high":
    case "new_low":
      return { kind: condition.kind, field: condition.field, n: text(condition.n) };
    case "value_range": {
      const places = wonPlaces(condition.field);
      return { kind: "value_range", field: condition.field, min: boundText(condition.min, places), max: boundText(condition.max, places) };
    }
    case "change":
      return { kind: "change", back: text(condition.back), minPct: boundText(condition.minPct), maxPct: boundText(condition.maxPct) };
    case "near_extreme":
      return { kind: "near_extreme", extreme: condition.extreme, n: text(condition.n), withinPct: numberText(condition.withinPct) };
    case "surge":
      return { kind: "surge", field: condition.field, n: text(condition.n), times: numberText(condition.times) };
    case "ma_position":
      return { kind: "ma_position", field: condition.field, method: condition.method, length: text(condition.length), side: condition.side };
    case "ma_alignment":
      return { kind: "ma_alignment", method: condition.method, lengths: condition.lengths.map(text), order: condition.order };
    case "ma_cross": {
      const { fast } = condition;
      return { ...DEFAULTS.ma_cross, method: condition.method, fastLine: fast === null ? "close" : "ma", ...(fast === null ? {} : { fast: text(fast) }), slow: text(condition.slow), direction: condition.direction };
    }
    case "rsi": {
      const { test } = condition;
      const read = test.kind === "range" ? { min: boundText(test.min), max: boundText(test.max) } : { value: numberText(test.value), direction: test.direction };
      return { ...DEFAULTS.rsi, length: text(condition.length), test: test.kind, ...read };
    }
    case "macd": {
      const { test } = condition;
      return { ...DEFAULTS.macd, fast: text(condition.fast), slow: text(condition.slow), signal: text(condition.signal), test: test.kind, ...(test.kind === "vs_signal" ? { side: test.side } : { direction: test.direction }) };
    }
    case "stochastic": {
      const { test } = condition;
      const read = test.kind === "range" ? { min: boundText(test.min), max: boundText(test.max) } : { direction: test.direction };
      return { ...DEFAULTS.stochastic, k: text(condition.k), d: text(condition.d), smooth: text(condition.smooth), test: test.kind, ...read };
    }
    case "bollinger": {
      const { test } = condition;
      return { ...DEFAULTS.bollinger, length: text(condition.length), k: numberText(condition.k), test: test.kind, ...(test.kind === "outside" ? { side: test.side } : { band: test.band, direction: test.direction }) };
    }
    case "ichimoku": {
      const { test } = condition;
      return {
        ...DEFAULTS.ichimoku,
        conversion: text(condition.conversion),
        base: text(condition.base),
        spanB: text(condition.spanB),
        displacement: text(condition.displacement),
        test: test.kind,
        ...(test.kind === "cloud" ? { side: test.side } : { direction: test.direction }),
      };
    }
    case "market_cap":
      return { kind: "market_cap", min: boundText(condition.min, EOK_PLACES), max: boundText(condition.max, EOK_PLACES) };
  }
}

const newCondition = (key: number, period: ScreenPeriod): ConditionDraft => ({ key, period, m: "1", ...DEFAULTS.new_high });

export function draftOf(screen: Screen | null): ScreenDraft {
  if (!screen) return { name: "", conditions: [newCondition(0, "D")], markets: [], exclude: [] };
  const conditions: ConditionDraft[] = [];
  for (const condition of screen.conditions) {
    const line = condition.kind === "market_cap" ? { period: conditions.at(-1)?.period ?? "D", m: "1" } : { period: condition.period, m: text(condition.m) };
    conditions.push({ key: conditions.length, ...line, ...fieldsOf(condition) });
  }
  return { name: screen.name, conditions, markets: screen.markets, exclude: screen.exclude };
}

export function addCondition(draft: ScreenDraft): ScreenDraft {
  if (draft.conditions.length >= MAX_CONDITIONS) return draft;
  const key = Math.max(-1, ...draft.conditions.map((c) => c.key)) + 1;
  return { ...draft, conditions: [...draft.conditions, newCondition(key, draft.conditions.at(-1)?.period ?? "D")] };
}

export function removeCondition(draft: ScreenDraft, key: number): ScreenDraft {
  if (draft.conditions.length <= 1) return draft;
  return { ...draft, conditions: draft.conditions.filter((c) => c.key !== key) };
}

export function editCondition(draft: ScreenDraft, line: ConditionDraft): ScreenDraft {
  return { ...draft, conditions: draft.conditions.map((c) => (c.key === line.key ? line : c)) };
}

const isTradeHigh = (choice: KindChoice): choice is TradeHigh => Object.hasOwn(TRADE_HIGHS, choice);

export function kindChoiceOf(line: KindFields): KindChoice {
  if (line.kind !== "new_high") return line.kind;
  return (Object.keys(TRADE_HIGHS) as TradeHigh[]).find((choice) => TRADE_HIGHS[choice] === line.field) ?? "new_high";
}

function chosenLine({ key, period, m }: ConditionDraft, choice: KindChoice): ConditionDraft {
  if (isTradeHigh(choice)) return { key, ...TRADE_HIGH_START, kind: "new_high", field: TRADE_HIGHS[choice] };
  return { key, period, m, ...DEFAULTS[choice] };
}

export function changeKind(draft: ScreenDraft, key: number, choice: KindChoice): ScreenDraft {
  return { ...draft, conditions: draft.conditions.map((c) => (c.key === key && kindChoiceOf(c) !== choice ? chosenLine(c, choice) : c)) };
}

export function moveCondition(draft: ScreenDraft, key: number, by: -1 | 1): ScreenDraft {
  const from = draft.conditions.findIndex((c) => c.key === key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= draft.conditions.length) return draft;
  const conditions = [...draft.conditions];
  [conditions[from], conditions[to]] = [conditions[to]!, conditions[from]!];
  return { ...draft, conditions };
}

type Lengths = Extract<ConditionDraft, { kind: "ma_alignment" }>;

export function addMaLine(line: Lengths): Lengths {
  if (line.lengths.length >= MAX_MA_LINES) return line;
  const longest = Number(line.lengths.at(-1));
  return { ...line, lengths: [...line.lengths, Number.isSafeInteger(longest) && longest > 0 ? text(Math.min(2 * longest, MAX_INDICATOR_LENGTH)) : ""] };
}

export function removeMaLine(line: Lengths): Lengths {
  return line.lengths.length <= MIN_MA_LINES ? line : { ...line, lengths: line.lengths.slice(0, -1) };
}

export function toggleMarket(draft: ScreenDraft, market: Market): ScreenDraft {
  const markets = draft.markets.includes(market) ? draft.markets.filter((m) => m !== market) : [...draft.markets, market];
  return { ...draft, markets: MARKETS.filter((m) => markets.includes(m)) };
}

export function toggleExclude(draft: ScreenDraft, kind: ExcludeKind): ScreenDraft {
  const exclude = draft.exclude.includes(kind) ? draft.exclude.filter((k) => k !== kind) : [...draft.exclude, kind];
  return { ...draft, exclude: excludedInOrder(exclude) };
}

const count = (n: number) => n.toLocaleString("ko-KR");
const BAR_COUNT = /^(\d+|\d{1,3}(,\d{3})+)$/;

type Rule = "any" | "non_negative" | "positive" | "percent";
const RULE: Record<Rule, { fits(value: number): boolean; error: string }> = {
  any: { fits: () => true, error: "" },
  non_negative: { fits: (v) => v >= 0, error: "0 이상의 수를 넣으세요" },
  positive: { fits: (v) => v > 0, error: "0보다 큰 수를 넣으세요" },
  percent: { fits: (v) => v >= 0 && v <= 100, error: "0~100 사이의 수를 넣으세요" },
};

class LineReader {
  readonly errors: ConditionErrors = {};

  fail(key: FieldKey, error: string) {
    this.errors[key] ??= error;
  }

  fine(...keys: FieldKey[]): boolean {
    return keys.every((key) => this.errors[key] === undefined);
  }

  count(key: FieldKey, input: string, max = MAX_BARS): number {
    const trimmed = input.trim();
    const value = BAR_COUNT.test(trimmed) ? Number(trimmed.replaceAll(",", "")) : 0;
    if (value < 1) this.fail(key, "1 이상의 정수를 넣으세요");
    else if (value > max) this.fail(key, `${count(max)} 이하로 넣으세요`);
    return value;
  }

  length(key: FieldKey, input: string): number {
    return this.count(key, input, MAX_INDICATOR_LENGTH);
  }

  number(key: FieldKey, input: string, rule: Rule, places = 0): number {
    const value = typedNumber(input, places);
    if (value === null) this.fail(key, "숫자를 넣으세요");
    else if (!RULE[rule].fits(value)) this.fail(key, RULE[rule].error);
    return value ?? NaN;
  }

  bounds(minKey: FieldKey, maxKey: FieldKey, minInput: string, maxInput: string, rule: Rule, places = 0): [Bound, Bound] {
    const min = minInput.trim() === "" ? null : this.number(minKey, minInput, rule, places);
    const max = maxInput.trim() === "" ? null : this.number(maxKey, maxInput, rule, places);
    if (min === null && max === null) this.fail(minKey, "최소와 최대 가운데 하나는 넣으세요");
    else if (min !== null && max !== null && this.fine(minKey, maxKey) && min > max) this.fail(maxKey, "최소보다 작을 수 없습니다");
    return [min, max];
  }

  shorter(fastKey: FieldKey, fast: number, slowKey: FieldKey, slow: number, error: string) {
    if (this.fine(fastKey, slowKey) && fast >= slow) this.fail(fastKey, error);
  }

  result(condition: Condition): ConditionCheck {
    return Object.keys(this.errors).length === 0 ? { ok: true, condition } : { ok: false, errors: this.errors };
  }
}

export function checkCondition(line: ConditionDraft): ConditionCheck {
  const r = new LineReader();
  const { period } = line;
  const bars = (n: number) => `${count(n)}${UNIT[period]}`;
  const m = () => r.count("m", line.m);
  switch (line.kind) {
    case "new_high":
    case "new_low": {
      const n = r.count("n", line.n);
      const recent = m();
      if (r.fine("n", "m") && recent > n) r.fail("m", `${line.kind === "new_high" ? NEW_HIGH_NAME[line.field] : "신저가"} 기간 ${bars(n)}보다 길 수 없습니다`);
      return r.result({ kind: line.kind, period, m: recent, field: line.field, n });
    }
    case "value_range": {
      const [min, max] = r.bounds("min", "max", line.min, line.max, "non_negative", wonPlaces(line.field));
      return r.result({ kind: "value_range", period, m: m(), field: line.field, min, max });
    }
    case "change": {
      const back = r.count("back", line.back);
      const [minPct, maxPct] = r.bounds("minPct", "maxPct", line.minPct, line.maxPct, "any");
      return r.result({ kind: "change", period, m: m(), back, minPct, maxPct });
    }
    case "near_extreme": {
      const n = r.count("n", line.n);
      const withinPct = r.number("withinPct", line.withinPct, "percent");
      return r.result({ kind: "near_extreme", period, m: m(), extreme: line.extreme, n, withinPct });
    }
    case "surge": {
      const n = r.count("n", line.n);
      const times = r.number("times", line.times, "positive");
      return r.result({ kind: "surge", period, m: m(), field: line.field, n, times });
    }
    case "ma_position": {
      const length = r.length("length", line.length);
      return r.result({ kind: "ma_position", period, m: m(), field: line.field, method: line.method, length, side: line.side });
    }
    case "ma_alignment": {
      const lengths = line.lengths.map((input, i) => r.length(`lengths.${i}`, input));
      lengths.forEach((length, i) => {
        const shorter = lengths[i - 1];
        if (i > 0 && shorter !== undefined && r.fine(`lengths.${i - 1}`, `lengths.${i}`) && length <= shorter) r.fail(`lengths.${i}`, `앞 이평 ${bars(shorter)}보다 길어야 합니다`);
      });
      return r.result({ kind: "ma_alignment", period, m: m(), method: line.method, lengths, order: line.order });
    }
    case "ma_cross": {
      const fast = line.fastLine === "close" ? null : r.length("fast", line.fast);
      const slow = r.length("slow", line.slow);
      if (fast !== null) r.shorter("fast", fast, "slow", slow, `긴 이평 ${bars(slow)}보다 짧아야 합니다`);
      return r.result({ kind: "ma_cross", period, m: m(), method: line.method, fast, slow, direction: line.direction });
    }
    case "rsi": {
      const length = r.length("length", line.length);
      if (line.test === "range") {
        const [min, max] = r.bounds("min", "max", line.min, line.max, "percent");
        return r.result({ kind: "rsi", period, m: m(), length, test: { kind: "range", min, max } });
      }
      const value = r.number("value", line.value, "percent");
      return r.result({ kind: "rsi", period, m: m(), length, test: { kind: "breakout", value, direction: line.direction } });
    }
    case "macd": {
      const fast = r.length("fast", line.fast);
      const slow = r.length("slow", line.slow);
      const signal = r.length("signal", line.signal);
      r.shorter("fast", fast, "slow", slow, `느린 기간 ${bars(slow)}보다 짧아야 합니다`);
      const test: MacdTest = line.test === "vs_signal" ? { kind: "vs_signal", side: line.side } : { kind: line.test, direction: line.direction };
      return r.result({ kind: "macd", period, m: m(), fast, slow, signal, test });
    }
    case "stochastic": {
      const k = r.length("k", line.k);
      const d = r.length("d", line.d);
      const smooth = r.length("smooth", line.smooth);
      if (line.test === "cross") return r.result({ kind: "stochastic", period, m: m(), k, d, smooth, test: { kind: "cross", direction: line.direction } });
      const [min, max] = r.bounds("min", "max", line.min, line.max, "percent");
      return r.result({ kind: "stochastic", period, m: m(), k, d, smooth, test: { kind: "range", min, max } });
    }
    case "bollinger": {
      const length = r.length("length", line.length);
      const k = r.number("k", line.k, "positive");
      const test = line.test === "outside" ? ({ kind: "outside", side: line.side } as const) : ({ kind: "cross", band: line.band, direction: line.direction } as const);
      return r.result({ kind: "bollinger", period, m: m(), length, k, test });
    }
    case "ichimoku": {
      const conversion = r.length("conversion", line.conversion);
      const base = r.length("base", line.base);
      const spanB = r.length("spanB", line.spanB);
      const displacement = r.length("displacement", line.displacement);
      const test = line.test === "cloud" ? ({ kind: "cloud", side: line.side } as const) : ({ kind: "cross", direction: line.direction } as const);
      return r.result({ kind: "ichimoku", period, m: m(), conversion, base, spanB, displacement, test });
    }
    case "market_cap": {
      const [min, max] = r.bounds("min", "max", line.min, line.max, "non_negative", EOK_PLACES);
      return r.result({ kind: "market_cap", min, max });
    }
  }
}

function checkName(name: string): string | null {
  const length = [...name.trim()].length;
  if (length === 0) return "이름을 넣으세요";
  if (length > MAX_SCREEN_NAME) return `이름은 ${MAX_SCREEN_NAME}자까지입니다 (지금 ${length}자)`;
  return null;
}

function listProblem(id: string, saved: readonly Screen[]): string | null {
  if (saved.some((s) => s.id === id)) return null;
  return saved.length >= MAX_SCREENS ? `조건식은 ${MAX_SCREENS}개까지 저장할 수 있습니다. 하나를 지운 뒤 만드세요.` : null;
}

export function checkDraft(draft: ScreenDraft, id: string, saved: readonly Screen[]): DraftCheck {
  const name = checkName(draft.name);
  const list = listProblem(id, saved);
  const conditions = draft.conditions.flatMap((c) => {
    const row = checkCondition(c);
    return row.ok ? [row.condition] : [];
  });
  if (name === null && list === null && conditions.length === draft.conditions.length) {
    return { ok: true, screen: { id, name: draft.name.trim(), markets: [...draft.markets], exclude: [...draft.exclude], conditions } };
  }
  return { ok: false, errors: { name, list } };
}

export function withScreen(saved: readonly Screen[], screen: Screen): Screen[] {
  return saved.some((s) => s.id === screen.id) ? saved.map((s) => (s.id === screen.id ? screen : s)) : [...saved, screen];
}
