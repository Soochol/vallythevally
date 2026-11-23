import { type ReactNode } from "react";
import { Select } from "../menu/Select";
import { CloseIcon, PlusIcon } from "../icons";
import { NumberToken } from "../screener/NumberToken";
import type { BarField } from "../../api/generated/BarField";
import type { BollingerBand } from "../../api/generated/BollingerBand";
import type { Direction } from "../../api/generated/Direction";
import type { Extreme } from "../../api/generated/Extreme";
import type { MaMethod } from "../../api/generated/MaMethod";
import type { MaOrder } from "../../api/generated/MaOrder";
import type { MacdTest } from "../../api/generated/MacdTest";
import type { PriceField } from "../../api/generated/PriceField";
import type { ScreenPeriod } from "../../api/generated/ScreenPeriod";
import type { Side } from "../../api/generated/Side";
import type { SurgeField } from "../../api/generated/SurgeField";
import { BAND_LABEL, DIRECTION_LABEL, EXTREME_LABEL, FIELD_LABEL, KIND_LABEL, MA_METHOD_LABEL, MA_ORDER_LABEL, NEW_HIGH_NAME, NEW_LOW_NAME, PERIOD_NAME, SIDE_LABEL, UNIT, VALUE_UNIT } from "../../lib/screener";
import { addMaLine, removeMaLine, MAX_MA_LINES, MIN_MA_LINES, type CloseOrMa, type ConditionDraft, type ConditionErrors, type FieldKey, type KindChoice } from "./screenForm";

export interface LineUi {
  label: string;
  base: string;
  kind: KindChoice;
  errors: ConditionErrors;
  numberPeriod: { value: ScreenPeriod; apply(field: FieldKey, value: string, period: ScreenPeriod): void };
}
type Options<T extends string> = readonly (readonly [T, string])[];
const optionsOf = <T extends string>(labels: Record<T, string>, values: readonly T[]): Options<T> => values.map((v) => [v, labels[v]] as const);

export const PERIODS = optionsOf<ScreenPeriod>(PERIOD_NAME, ["D", "W", "M"]);
const BAR_FIELDS = optionsOf<BarField>(FIELD_LABEL, ["open", "high", "low", "close", "volume", "traded_value"]);
const PRICE_FIELDS = optionsOf<PriceField>(FIELD_LABEL, ["open", "high", "low", "close"]);
const SURGE_FIELDS = optionsOf<SurgeField>(FIELD_LABEL, ["volume", "traded_value"]);
const METHODS = optionsOf<MaMethod>(MA_METHOD_LABEL, ["sma", "ema"]);
const SIDES = optionsOf<Side>(SIDE_LABEL, ["above", "below"]);
const DIRECTIONS = optionsOf<Direction>(DIRECTION_LABEL, ["up", "down"]);
const EXTREMES = optionsOf<Extreme>(EXTREME_LABEL, ["high", "low"]);
const ORDERS = optionsOf<MaOrder>(MA_ORDER_LABEL, ["bullish", "bearish"]);
const BANDS = optionsOf<BollingerBand>(BAND_LABEL, ["upper", "lower"]);
const FAST_LINES: Options<CloseOrMa> = [
  ["ma", "짧은 이평"],
  ["close", "종가"],
];
const RSI_TESTS: Options<"range" | "breakout"> = [
  ["range", "범위"],
  ["breakout", "기준값"],
];
const MACD_TESTS: Options<MacdTest["kind"]> = [
  ["signal_cross", "시그널선"],
  ["zero_breakout", "0선"],
  ["vs_signal", "시그널 대비"],
];
const STOCHASTIC_TESTS: Options<"cross" | "range"> = [
  ["cross", "%D"],
  ["range", "범위"],
];
const BOLLINGER_TESTS: Options<"outside" | "cross"> = [
  ["outside", "벗어난"],
  ["cross", "교차한"],
];
const BOLLINGER_SIDES: Options<Side> = [
  ["above", "상단 위"],
  ["below", "하단 아래"],
];
const ICHIMOKU_TESTS: Options<"cloud" | "cross"> = [
  ["cloud", "구름"],
  ["cross", "전환선"],
];

export const CHOICE_LABEL: Record<KindChoice, string> = { ...KIND_LABEL, volume_high: NEW_HIGH_NAME.volume, traded_value_high: NEW_HIGH_NAME.traded_value };
const VALUE_FIELDS: Partial<Record<KindChoice, Options<BarField>>> = { new_high: PRICE_FIELDS, new_low: BAR_FIELDS };

const FIELD_NAME: Record<Exclude<FieldKey, `lengths.${number}`>, string> = {
  recentBars: "최근 기간",
  n: "기간",
  min: "최소",
  max: "최대",
  back: "비교 봉 수",
  minPct: "최소 등락률",
  maxPct: "최대 등락률",
  withinPct: "거리",
  times: "배수",
  length: "기간",
  fast: "빠른 기간",
  slow: "느린 기간",
  signal: "시그널 기간",
  value: "돌파 값",
  k: "%K 기간",
  d: "%D 기간",
  smooth: "평활 기간",
  conversion: "전환선 기간",
  base: "기준선 기간",
  spanB: "선행스팬 B 기간",
  displacement: "이동 봉 수",
};
const KIND_FIELD_NAME: { [K in KindChoice]?: Partial<Record<FieldKey, string>> } = {
  new_high: { n: "신고가 기간" },
  new_low: { n: "신저가 기간" },
  volume_high: { n: `${NEW_HIGH_NAME.volume} 기간` },
  traded_value_high: { n: `${NEW_HIGH_NAME.traded_value} 기간` },
  surge: { n: "평균 기간" },
  ma_position: { length: "이평 기간" },
  ma_cross: { fast: "짧은 이평", slow: "긴 이평" },
  rsi: { length: "RSI 기간" },
  bollinger: { k: "표준편차 배수" },
};

const LENGTHS = "lengths.";
const isLengthKey = (key: FieldKey): key is `lengths.${number}` => key.startsWith(LENGTHS);

export function fieldName(kind: KindChoice, key: FieldKey): string {
  if (isLengthKey(key)) return `이평 ${Number(key.slice(LENGTHS.length)) + 1}`;
  return KIND_FIELD_NAME[kind]?.[key] ?? FIELD_NAME[key];
}

const BAR_COUNTS: Record<ScreenPeriod, readonly string[]> = { D: ["5", "20", "60", "120", "250"], W: ["4", "13", "26", "52"], M: ["3", "6", "12", "24"] };
const RECENT_BARS: Record<ScreenPeriod, readonly string[]> = { D: ["1", "3", "5", "10", "20"], W: ["1", "2", "4", "8"], M: ["1", "2", "3", "6"] };
const INDICATOR_PRESETS: { [K in KindChoice]?: Partial<Record<FieldKey, readonly string[]>> } = {
  rsi: { length: ["9", "14", "21"], min: ["20", "30", "50"], max: ["50", "70", "80"], value: ["30", "50", "70"] },
  macd: { fast: ["5", "12"], slow: ["26", "35"], signal: ["5", "9"] },
  stochastic: { k: ["5", "9", "14"], d: ["3", "5"], smooth: ["1", "3"], min: ["20", "50"], max: ["50", "80"] },
  bollinger: { length: ["10", "20", "40"], k: ["1.5", "2", "2.5", "3"] },
  ichimoku: { conversion: ["9"], base: ["26"], spanB: ["52"], displacement: ["26"] },
  surge: { times: ["2", "3", "5", "10"] },
  near_extreme: { withinPct: ["1", "3", "5", "10"] },
  change: { minPct: ["-5", "0", "3", "5", "10"], maxPct: ["-5", "0", "3", "5", "10"] },
};
const BAR_COUNT_FIELDS: ReadonlySet<FieldKey> = new Set(["n", "back"]);
const MA_FIELDS: ReadonlySet<KindChoice> = new Set(["ma_position", "ma_alignment", "ma_cross"]);

function presetsOf(kind: KindChoice, field: FieldKey): { values: (period: ScreenPeriod) => readonly string[]; periodic: boolean } {
  if (field === "recentBars") return { values: (period) => RECENT_BARS[period], periodic: true };
  if (BAR_COUNT_FIELDS.has(field) || (MA_FIELDS.has(kind) && (isLengthKey(field) || field === "length" || field === "fast" || field === "slow"))) return { values: (period) => BAR_COUNTS[period], periodic: true };
  const values = INDICATOR_PRESETS[kind]?.[field] ?? [];
  return { values: () => values, periodic: false };
}

const hasFinal = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
};
const subjectMark = (word: string) => (hasFinal(word) ? "이" : "가");
const objectMark = (word: string) => (hasFinal(word) ? "을" : "를");
const towardMark = (word: string) => (hasFinal(word) && (word.charCodeAt(word.length - 1) - 0xac00) % 28 !== 8 ? "으로" : "로");
const labelOf = <T extends string>(options: Options<T>, value: T) => options.find(([v]) => v === value)?.[1] ?? "";

export const Word = ({ children }: { children: ReactNode }) => <span className="sentence-word">{children}</span>;

interface NumberProps {
  ui: LineUi;
  field: FieldKey;
  value: string;
  onChange(value: string): void;
}

export function NumberBox({ ui, field, value, onChange }: NumberProps) {
  const error = ui.errors[field];
  const name = fieldName(ui.kind, field);
  const { values, periodic } = presetsOf(ui.kind, field);
  const period = ui.numberPeriod.value;
  return <NumberToken label={`${ui.label} ${name}`} meaning={periodic ? `${name} (${UNIT[period]} 단위 봉 개수)` : name} value={value} error={error} describedBy={error ? `${ui.base}-${field}-error` : undefined} presets={values(period)} period={periodic ? period : undefined}
    onChange={(next, nextPeriod) => { if (periodic && nextPeriod) ui.numberPeriod.apply(field, next, nextPeriod); else onChange(next); }} />;
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: Options<T>;
  onChange(value: T): void;
}

export function Choice<T extends string>({ label, value, options, onChange }: ChoiceProps<T>) {
  return <Select label={label} value={value} options={options.map(([value, label]) => ({ value, label }))} onChange={onChange} className="ui-field px-1.5" />;
}

interface RangeProps {
  ui: LineUi;
  keys: readonly ["min", "max"] | readonly ["minPct", "maxPct"];
  unit: string;
  min: string;
  max: string;
  end: string;
  onChange(min: string, max: string): void;
}

const RANGE_MODES: Options<"min" | "max" | "range"> = [["min", "이상"], ["max", "이하"], ["range", "이상 ~"]];

function RangeTokens({ ui, keys: [minKey, maxKey], unit, min, max, end, onChange }: RangeProps) {
  const mode = min !== "" && max !== "" ? "range" : max !== "" ? "max" : "min";
  const modeChoice = <Select label={`${ui.label} 비교`} value={mode} options={RANGE_MODES.map(([value, label]) => ({ value, label, hint: value === "range" ? "범위" : undefined }))} onChange={(next) => onChange(next === "max" ? "" : min || max, next === "min" ? "" : max || min)} className="ui-field px-1.5" />;
  return <>
    {mode !== "max" && <Word><NumberBox ui={ui} field={minKey} value={min} onChange={(v) => onChange(v, max)} />{unit}</Word>}
    {mode === "max" ? <Word><NumberBox ui={ui} field={maxKey} value={max} onChange={(v) => onChange(min, v)} />{unit}</Word> : <Word>{modeChoice}{mode === "min" && end}</Word>}
    {mode === "range" && <Word><NumberBox ui={ui} field={maxKey} value={max} onChange={(v) => onChange(min, v)} />{unit}</Word>}
    {mode === "max" ? <Word>{modeChoice}{end}</Word> : mode === "range" && <span>이하{end}</span>}
  </>;
}

const BOUNDS = ["min", "max"] as const;

interface KindProps {
  ui: LineUi;
  line: ConditionDraft;
  onChange(line: ConditionDraft): void;
}

export function KindFields({ ui, line, onChange }: KindProps) {
  const unit = UNIT[line.period];
  const choice = (name: string) => `${ui.label} ${name}`;
  const number = (field: FieldKey, value: string, apply: (value: string) => void) => <NumberBox ui={ui} field={field} value={value} onChange={apply} />;
  const direction = <L extends Extract<ConditionDraft, { direction: Direction }>>(directed: L, after = "") => (
    <Word><Choice label={choice("방향")} value={directed.direction} options={DIRECTIONS} onChange={(direction) => onChange({ ...directed, direction })} />{after}</Word>
  );
  switch (line.kind) {
    case "new_high":
    case "new_low": {
      const fields = VALUE_FIELDS[ui.kind];
      return (
        <>
          {fields && <Word><Choice label={choice("값")} value={line.field} options={fields} onChange={(field) => onChange({ ...line, field })} />{subjectMark(FIELD_LABEL[line.field])}</Word>}
          <Word>{number("n", line.n, (n) => onChange({ ...line, n }))}{unit}</Word>
          <span>{(line.kind === "new_high" ? NEW_HIGH_NAME : NEW_LOW_NAME)[line.field]}인</span>
        </>
      );
    }
    case "value_range":
      return (
        <>
          <Word><Choice label={choice("값")} value={line.field} options={BAR_FIELDS} onChange={(field) => onChange({ ...line, field })} />{subjectMark(FIELD_LABEL[line.field])}</Word>
          <RangeTokens ui={ui} keys={BOUNDS} unit={VALUE_UNIT[line.field]} min={line.min} max={line.max} end="인" onChange={(min, max) => onChange({ ...line, min, max })} />
        </>
      );
    case "change":
      return (
        <>
          <span>종가가</span>
          <Word>{number("back", line.back, (back) => onChange({ ...line, back }))}{unit}</Word>
          <span>전보다</span>
          <RangeTokens ui={ui} keys={["minPct", "maxPct"]} unit="%" min={line.minPct} max={line.maxPct} end="인" onChange={(minPct, maxPct) => onChange({ ...line, minPct, maxPct })} />
        </>
      );
    case "near_extreme":
      return (
        <>
          <span>종가가</span>
          <Word>{number("n", line.n, (n) => onChange({ ...line, n }))}{unit}</Word>
          <Word><Choice label={choice("고점·저점")} value={line.extreme} options={EXTREMES} onChange={(extreme) => onChange({ ...line, extreme })} />에서</Word>
          <Word>{number("withinPct", line.withinPct, (withinPct) => onChange({ ...line, withinPct }))}%</Word>
          <span>이내인</span>
        </>
      );
    case "surge":
      return (
        <>
          <Word><Choice label={choice("값")} value={line.field} options={SURGE_FIELDS} onChange={(field) => onChange({ ...line, field })} />{subjectMark(FIELD_LABEL[line.field])}</Word>
          <span>직전</span>
          <Word>{number("n", line.n, (n) => onChange({ ...line, n }))}{unit}</Word>
          <span>평균의</span>
          <Word>{number("times", line.times, (times) => onChange({ ...line, times }))}배</Word>
          <span>이상인</span>
        </>
      );
    case "ma_position":
      return (
        <>
          <Word><Choice label={choice("값")} value={line.field} options={PRICE_FIELDS} onChange={(field) => onChange({ ...line, field })} />{subjectMark(FIELD_LABEL[line.field])}</Word>
          <Word>{number("length", line.length, (length) => onChange({ ...line, length }))}{unit}</Word>
          <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
          <span>이동평균</span>
          <Word><Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} />인</Word>
        </>
      );
    case "ma_alignment":
      return (
        <>
          <Word>
            {line.lengths.map((length, i) => (
              <span key={i} className="contents">
                {i > 0 && "·"}
                {number(`lengths.${i}`, length, (value) => onChange({ ...line, lengths: line.lengths.map((l, j) => (j === i ? value : l)) }))}
              </span>
            ))}
            {unit}
          </Word>
          <span className="inline-flex">
            <button type="button" className="icon-btn h-6 w-6" aria-label={`${ui.label} 이평 더하기`} title="이평 더하기" disabled={line.lengths.length >= MAX_MA_LINES} onClick={() => onChange(addMaLine(line))}>
              <PlusIcon size={12} />
            </button>
            <button type="button" className="icon-btn h-6 w-6" aria-label={`${ui.label} 이평 빼기`} title="이평 빼기" disabled={line.lengths.length <= MIN_MA_LINES} onClick={() => onChange(removeMaLine(line))}>
              <CloseIcon size={10} />
            </button>
          </span>
          <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
          <span>이동평균이</span>
          <Word><Choice label={choice("배열")} value={line.order} options={ORDERS} onChange={(order) => onChange({ ...line, order })} />인</Word>
        </>
      );
    case "ma_cross":
      return (
        <>
          <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
          {line.fastLine === "ma" ? (
            <>
              <Choice label={choice("짧은 선")} value={line.fastLine} options={FAST_LINES} onChange={(fastLine) => onChange({ ...line, fastLine })} />
              <Word>{number("fast", line.fast, (fast) => onChange({ ...line, fast }))}{unit}선이</Word>
            </>
          ) : (
            <Word><Choice label={choice("짧은 선")} value={line.fastLine} options={FAST_LINES} onChange={(fastLine) => onChange({ ...line, fastLine })} />가</Word>
          )}
          <Word>{number("slow", line.slow, (slow) => onChange({ ...line, slow }))}{unit}선을</Word>
          {direction(line)}
          <span>교차한</span>
        </>
      );
    case "rsi":
      return (
        <>
          <Word>RSI({number("length", line.length, (length) => onChange({ ...line, length }))})가</Word>
          <Choice label={choice("판정")} value={line.test} options={RSI_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "range" ? (
            <RangeTokens ui={ui} keys={BOUNDS} unit="" min={line.min} max={line.max} end="인" onChange={(min, max) => onChange({ ...line, min, max })} />
          ) : (
            <>
              <Word>{number("value", line.value, (value) => onChange({ ...line, value }))}{objectMark(line.value)}</Word>
              {direction(line)}
              <span>돌파한</span>
            </>
          )}
        </>
      );
    case "macd":
      return (
        <>
          <span>MACD(빠른</span>
          <Word>{number("fast", line.fast, (fast) => onChange({ ...line, fast }))},</Word>
          <span>느린</span>
          <Word>{number("slow", line.slow, (slow) => onChange({ ...line, slow }))},</Word>
          <span>시그널</span>
          <Word>{number("signal", line.signal, (signal) => onChange({ ...line, signal }))})가</Word>
          {line.test === "vs_signal" ? (
            <>
              <Choice label={choice("판정")} value={line.test} options={MACD_TESTS} onChange={(test) => onChange({ ...line, test })} />
              <Word><Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} />인</Word>
            </>
          ) : (
            <>
              <Word><Choice label={choice("판정")} value={line.test} options={MACD_TESTS} onChange={(test) => onChange({ ...line, test })} />{objectMark(labelOf(MACD_TESTS, line.test))}</Word>
              {direction(line)}
              <span>{line.test === "signal_cross" ? "교차한" : "돌파한"}</span>
            </>
          )}
        </>
      );
    case "stochastic":
      return (
        <>
          <span>스토캐스틱(%K</span>
          <Word>{number("k", line.k, (k) => onChange({ ...line, k }))},</Word>
          <span>%D</span>
          <Word>{number("d", line.d, (d) => onChange({ ...line, d }))},</Word>
          <span>평활</span>
          <Word>{number("smooth", line.smooth, (smooth) => onChange({ ...line, smooth }))})의</Word>
          <span>%K가</span>
          {line.test === "cross" ? (
            <>
              <Word><Choice label={choice("판정")} value={line.test} options={STOCHASTIC_TESTS} onChange={(test) => onChange({ ...line, test })} />를</Word>
              {direction(line)}
              <span>교차한</span>
            </>
          ) : (
            <>
              <Choice label={choice("판정")} value={line.test} options={STOCHASTIC_TESTS} onChange={(test) => onChange({ ...line, test })} />
              <RangeTokens ui={ui} keys={BOUNDS} unit="" min={line.min} max={line.max} end="인" onChange={(min, max) => onChange({ ...line, min, max })} />
            </>
          )}
        </>
      );
    case "bollinger":
      return (
        <>
          <span>볼린저 밴드(기간</span>
          <Word>{number("length", line.length, (length) => onChange({ ...line, length }))},</Word>
          <span>배수</span>
          <Word>{number("k", line.k, (k) => onChange({ ...line, k }))})의</Word>
          {line.test === "outside" ? (
            <Word><Choice label={choice("위치")} value={line.side} options={BOLLINGER_SIDES} onChange={(side) => onChange({ ...line, side })} />{towardMark(labelOf(BOLLINGER_SIDES, line.side))}</Word>
          ) : (
            <>
              <Word><Choice label={choice("밴드")} value={line.band} options={BANDS} onChange={(band) => onChange({ ...line, band })} />{objectMark(BAND_LABEL[line.band])}</Word>
              {direction(line)}
            </>
          )}
          <Choice label={choice("판정")} value={line.test} options={BOLLINGER_TESTS} onChange={(test) => onChange({ ...line, test })} />
        </>
      );
    case "ichimoku":
      return (
        <>
          <span>일목균형표(전환</span>
          <Word>{number("conversion", line.conversion, (conversion) => onChange({ ...line, conversion }))},</Word>
          <span>기준</span>
          <Word>{number("base", line.base, (base) => onChange({ ...line, base }))},</Word>
          <span>선행</span>
          <Word>{number("spanB", line.spanB, (spanB) => onChange({ ...line, spanB }))},</Word>
          <span>이동</span>
          <Word>{number("displacement", line.displacement, (displacement) => onChange({ ...line, displacement }))})의</Word>
          {line.test === "cloud" ? (
            <>
              <Choice label={choice("판정")} value={line.test} options={ICHIMOKU_TESTS} onChange={(test) => onChange({ ...line, test })} />
              <Word><Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} />인</Word>
            </>
          ) : (
            <>
              <Word><Choice label={choice("판정")} value={line.test} options={ICHIMOKU_TESTS} onChange={(test) => onChange({ ...line, test })} />이</Word>
              <span>기준선을</span>
              {direction(line)}
              <span>교차한</span>
            </>
          )}
        </>
      );
    case "market_cap":
      return <>
        <RangeTokens ui={ui} keys={BOUNDS} unit="억 원" min={line.min} max={line.max} end="이다" onChange={(min, max) => onChange({ ...line, min, max })} />
      </>;
  }
}
