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
  sentence?: boolean;
  numberPeriod?: { value: ScreenPeriod; apply(field: FieldKey, value: string, period: ScreenPeriod): void };
}
const FIELD_BOX = "ui-field";
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
  ["breakout", "돌파"],
];
const MACD_TESTS: Options<MacdTest["kind"]> = [
  ["signal_cross", "시그널 교차"],
  ["zero_breakout", "0선 돌파"],
  ["vs_signal", "시그널 대비"],
];
const STOCHASTIC_TESTS: Options<"cross" | "range"> = [
  ["cross", "%K·%D 교차"],
  ["range", "%K 범위"],
];
const BOLLINGER_TESTS: Options<"outside" | "cross"> = [
  ["outside", "밴드 밖"],
  ["cross", "밴드 교차"],
];
const BOLLINGER_SIDES: Options<Side> = [
  ["above", "상단 위"],
  ["below", "하단 아래"],
];
const ICHIMOKU_TESTS: Options<"cloud" | "cross"> = [
  ["cloud", "구름"],
  ["cross", "전환선·기준선 교차"],
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


type Width = "count" | "length" | "amount" | "percent";
const WIDTH: Record<Width, string> = { count: "w-[72px]", length: "w-[52px]", amount: "w-[88px]", percent: "w-[60px]" };

interface NumberProps {
  ui: LineUi;
  field: FieldKey;
  value: string;
  width?: Width;
  onChange(value: string): void;
}

export function NumberBox({ ui, field, value, width = "count", onChange }: NumberProps) {
  const error = ui.errors[field];
  if (ui.sentence) {
    const numberPeriod = width === "percent" || width === "amount" ? undefined : ui.numberPeriod;
    return <NumberToken label={`${ui.label} ${fieldName(ui.kind, field)}`} value={value} error={error} describedBy={error ? `${ui.base}-${field}-error` : undefined} presets={numberPeriod ? ["5", "20", "52", "104", "260"] : []} period={numberPeriod?.value} onChange={(value, period) => { if (numberPeriod && period) numberPeriod.apply(field, value, period); else onChange(value); }} />;
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={`${ui.label} ${fieldName(ui.kind, field)}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={error !== undefined}
      aria-describedby={error !== undefined ? `${ui.base}-${field}-error` : undefined}
      autoComplete="off"
      className={`${FIELD_BOX} ${WIDTH[width]} px-2 text-right`}
    />
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: Options<T>;
  onChange(value: T): void;
}

export function Choice<T extends string>({ label, value, options, onChange }: ChoiceProps<T>) {
  return <Select label={label} value={value} options={options.map(([value, label]) => ({ value, label }))} onChange={onChange} className={`${FIELD_BOX} px-1.5`} />;
}

export const Together = ({ children }: { children: ReactNode }) => <span className="flex flex-none items-center gap-1.5">{children}</span>;

interface RangeProps {
  ui: LineUi;
  keys: readonly ["min", "max"] | readonly ["minPct", "maxPct"];
  unit: string;
  width: Width;
  min: string;
  max: string;
  onChange(min: string, max: string): void;
}

function RangeBoxes({ ui, keys: [minKey, maxKey], unit, width, min, max, onChange }: RangeProps) {
  if (ui.sentence) {
    const mode = min !== "" && max !== "" ? "range" : max !== "" ? "max" : "min";
    return <>
      {mode !== "max" && <><NumberBox ui={ui} field={minKey} value={min} width={width} onChange={(v) => onChange(v, max)} /><span>{unit}</span></>}
      {mode === "range" && <span>~</span>}
      {mode !== "min" && <><NumberBox ui={ui} field={maxKey} value={max} width={width} onChange={(v) => onChange(min, v)} /><span>{unit}</span></>}
      <Choice label={`${ui.label} 비교`} value={mode} options={[["min", "이상"], ["max", "이하"], ["range", "범위"]]} onChange={(next) => onChange(next === "max" ? "" : min || max, next === "min" ? "" : max || min)} />
    </>;
  }
  return (
    <>
      <Together>
        <NumberBox ui={ui} field={minKey} value={min} width={width} onChange={(v) => onChange(v, max)} />
        <span>{unit} 이상</span>
      </Together>
      <Together>
        <NumberBox ui={ui} field={maxKey} value={max} width={width} onChange={(v) => onChange(min, v)} />
        <span>{unit} 이하</span>
      </Together>
    </>
  );
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
  const direction = <L extends Extract<ConditionDraft, { direction: Direction }>>(directed: L) => (
    <Choice label={choice("방향")} value={directed.direction} options={DIRECTIONS} onChange={(direction) => onChange({ ...directed, direction })} />
  );
  switch (line.kind) {
    case "new_high":
    case "new_low": {
      const fields = VALUE_FIELDS[ui.kind];
      return (
        <>
          {fields && <Choice label={choice("값")} value={line.field} options={fields} onChange={(field) => onChange({ ...line, field })} />}
          <Together>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>
              {unit} {(line.kind === "new_high" ? NEW_HIGH_NAME : NEW_LOW_NAME)[line.field]}
            </span>
          </Together>
        </>
      );
    }
    case "value_range":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={BAR_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <RangeBoxes ui={ui} keys={BOUNDS} unit={VALUE_UNIT[line.field]} width="amount" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
        </>
      );
    case "change":
      return (
        <>
          <Together>
            <span>종가</span>
            <NumberBox ui={ui} field="back" value={line.back} onChange={(back) => onChange({ ...line, back })} />
            <span>{unit} 전보다</span>
          </Together>
          <RangeBoxes ui={ui} keys={["minPct", "maxPct"]} unit="%" width="percent" min={line.minPct} max={line.maxPct} onChange={(minPct, maxPct) => onChange({ ...line, minPct, maxPct })} />
        </>
      );
    case "near_extreme":
      return (
        <>
          <Together>
            <span>종가가</span>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>{unit}</span>
          </Together>
          <Together>
            <Choice label={choice("고점·저점")} value={line.extreme} options={EXTREMES} onChange={(extreme) => onChange({ ...line, extreme })} />
            <span>에서</span>
          </Together>
          <Together>
            <NumberBox ui={ui} field="withinPct" value={line.withinPct} width="percent" onChange={(withinPct) => onChange({ ...line, withinPct })} />
            <span>% 안</span>
          </Together>
        </>
      );
    case "surge":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={SURGE_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <Together>
            <span>직전</span>
            <NumberBox ui={ui} field="n" value={line.n} onChange={(n) => onChange({ ...line, n })} />
            <span>{unit} 평균의</span>
          </Together>
          <Together>
            <NumberBox ui={ui} field="times" value={line.times} width="percent" onChange={(times) => onChange({ ...line, times })} />
            <span>배 이상</span>
          </Together>
        </>
      );
    case "ma_position":
      return (
        <>
          <Choice label={choice("값")} value={line.field} options={PRICE_FIELDS} onChange={(field) => onChange({ ...line, field })} />
          <Together>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
            <span>{unit}</span>
          </Together>
          <Together>
            <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
            <span>이동평균</span>
          </Together>
          <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} />
        </>
      );
    case "ma_alignment":
      return (
        <>
          <Together>
            <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
            <span>이동평균</span>
          </Together>
          {line.lengths.map((length, i) => (
            <Together key={i}>
              {i > 0 && <span>·</span>}
              <NumberBox
                ui={ui}
                field={`lengths.${i}`}
                value={length}
                width="length"
                onChange={(value) => onChange({ ...line, lengths: line.lengths.map((l, j) => (j === i ? value : l)) })}
              />
              {i === line.lengths.length - 1 && <span>{unit}</span>}
            </Together>
          ))}
          <Together>
            <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${ui.label} 이평 더하기`} title="이평 더하기" disabled={line.lengths.length >= MAX_MA_LINES} onClick={() => onChange(addMaLine(line))}>
              <PlusIcon size={14} />
            </button>
            <button type="button" className="icon-btn h-7 w-7 max-md:h-10 max-md:w-10" aria-label={`${ui.label} 이평 빼기`} title="이평 빼기" disabled={line.lengths.length <= MIN_MA_LINES} onClick={() => onChange(removeMaLine(line))}>
              <CloseIcon size={12} />
            </button>
          </Together>
          <Choice label={choice("배열")} value={line.order} options={ORDERS} onChange={(order) => onChange({ ...line, order })} />
        </>
      );
    case "ma_cross":
      return (
        <>
          <Choice label={choice("계산 방식")} value={line.method} options={METHODS} onChange={(method) => onChange({ ...line, method })} />
          <Choice label={choice("짧은 선")} value={line.fastLine} options={FAST_LINES} onChange={(fastLine) => onChange({ ...line, fastLine })} />
          {line.fastLine === "ma" && (
            <Together>
              <NumberBox ui={ui} field="fast" value={line.fast} width="length" onChange={(fast) => onChange({ ...line, fast })} />
              <span>{unit}선이</span>
            </Together>
          )}
          <Together>
            <NumberBox ui={ui} field="slow" value={line.slow} width="length" onChange={(slow) => onChange({ ...line, slow })} />
            <span>{unit}선을</span>
          </Together>
          <Together>
            {direction(line)}
            <span>교차</span>
          </Together>
        </>
      );
    case "rsi":
      return (
        <>
          <Together>
            <span>RSI</span>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
          </Together>
          <Choice label={choice("판정")} value={line.test} options={RSI_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "range" ? (
            <RangeBoxes ui={ui} keys={BOUNDS} unit="" width="percent" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
          ) : (
            <Together>
              <NumberBox ui={ui} field="value" value={line.value} width="percent" onChange={(value) => onChange({ ...line, value })} />
              {direction(line)}
            </Together>
          )}
        </>
      );
    case "macd":
      return (
        <>
          <Together>
            <span>MACD</span>
            <NumberBox ui={ui} field="fast" value={line.fast} width="length" onChange={(fast) => onChange({ ...line, fast })} />
          </Together>
          <NumberBox ui={ui} field="slow" value={line.slow} width="length" onChange={(slow) => onChange({ ...line, slow })} />
          <NumberBox ui={ui} field="signal" value={line.signal} width="length" onChange={(signal) => onChange({ ...line, signal })} />
          <Choice label={choice("판정")} value={line.test} options={MACD_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "vs_signal" ? <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} /> : direction(line)}
        </>
      );
    case "stochastic":
      return (
        <>
          <Together>
            <span>스토캐스틱</span>
            <NumberBox ui={ui} field="k" value={line.k} width="length" onChange={(k) => onChange({ ...line, k })} />
          </Together>
          <NumberBox ui={ui} field="d" value={line.d} width="length" onChange={(d) => onChange({ ...line, d })} />
          <NumberBox ui={ui} field="smooth" value={line.smooth} width="length" onChange={(smooth) => onChange({ ...line, smooth })} />
          <Choice label={choice("판정")} value={line.test} options={STOCHASTIC_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "cross" ? (
            direction(line)
          ) : (
            <RangeBoxes ui={ui} keys={BOUNDS} unit="" width="percent" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />
          )}
        </>
      );
    case "bollinger":
      return (
        <>
          <Together>
            <span>볼린저</span>
            <NumberBox ui={ui} field="length" value={line.length} width="length" onChange={(length) => onChange({ ...line, length })} />
          </Together>
          <NumberBox ui={ui} field="k" value={line.k} width="length" onChange={(k) => onChange({ ...line, k })} />
          <Choice label={choice("판정")} value={line.test} options={BOLLINGER_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "outside" ? (
            <Choice label={choice("위치")} value={line.side} options={BOLLINGER_SIDES} onChange={(side) => onChange({ ...line, side })} />
          ) : (
            <Together>
              <Choice label={choice("밴드")} value={line.band} options={BANDS} onChange={(band) => onChange({ ...line, band })} />
              {direction(line)}
            </Together>
          )}
        </>
      );
    case "ichimoku":
      return (
        <>
          <Together>
            <span>일목</span>
            <NumberBox ui={ui} field="conversion" value={line.conversion} width="length" onChange={(conversion) => onChange({ ...line, conversion })} />
          </Together>
          <NumberBox ui={ui} field="base" value={line.base} width="length" onChange={(base) => onChange({ ...line, base })} />
          <NumberBox ui={ui} field="spanB" value={line.spanB} width="length" onChange={(spanB) => onChange({ ...line, spanB })} />
          <NumberBox ui={ui} field="displacement" value={line.displacement} width="length" onChange={(displacement) => onChange({ ...line, displacement })} />
          <Choice label={choice("판정")} value={line.test} options={ICHIMOKU_TESTS} onChange={(test) => onChange({ ...line, test })} />
          {line.test === "cloud" ? <Choice label={choice("위치")} value={line.side} options={SIDES} onChange={(side) => onChange({ ...line, side })} /> : direction(line)}
        </>
      );
    case "market_cap":
      return <RangeBoxes ui={ui} keys={BOUNDS} unit="억 원" width="amount" min={line.min} max={line.max} onChange={(min, max) => onChange({ ...line, min, max })} />;
  }
}
