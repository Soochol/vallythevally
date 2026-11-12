import { KIND_ORDER, KINDS, specName, type IndicatorKind } from "../../chart/indicators/kinds";
import { checkForm, formFromSpec, type FieldError, type SpecForm } from "../indicator-dialog/indicatorForm";
import { highlight, normalizeQuery } from "../search/highlight";

const ALIASES: Record<IndicatorKind, readonly string[]> = {
  ma: ["이동평균", "이평", "ma", "sma", "ema", "지수이평"],
  bollinger: ["볼린저 밴드", "볼밴", "bb", "bollinger"],
  ichimoku: ["일목균형표", "일목", "ichimoku"],
  volume: ["거래량", "volume", "vol"],
  rsi: ["RSI", "상대강도지수"],
  macd: ["MACD"],
  stochSlow: ["스토캐스틱 슬로우", "스토캐스틱", "stoch", "stochastic"],
  revenue: ["매출액", "매출", "revenue"],
  operating_income: ["영업이익", "operating income"],
  owner_roe: ["지배주주 ROE", "지배주주", "roe"],
  investing_cash_flow: ["투자활동 현금흐름", "투자현금흐름", "icf"],
  dps: ["DPS", "주당배당금", "배당"],
  debt_ratio: ["부채비율", "debt"],
};

export interface IndicatorCandidate {
  kind: IndicatorKind;
  label: string;
  form: SpecForm;
  errors: FieldError[];
}

export function parseIndicatorInput(input: string): IndicatorCandidate[] {
  const trimmed = input.trim();
  const numeric = /^(.*?)([+-]?(?:\d|\.\d).*)$/.exec(trimmed);
  let name = numeric?.[1]?.trim() ?? trimmed;
  let parameters = numeric?.[2] ?? "";
  if (numeric && name === "") return [];
  let query = normalizeQuery(name);
  const exact = KIND_ORDER.filter((kind) => ALIASES[kind].some((alias) => normalizeQuery(alias) === query));
  let matches = exact.length ? exact : KIND_ORDER.filter((kind) => ALIASES[kind].some((alias) => highlight(alias, query).some((part) => part.match)));
  if (query === "") matches = KIND_ORDER;
  if (!numeric && matches.length === 0) {
    const prefix = KIND_ORDER.flatMap((kind) => ALIASES[kind].map((alias) => ({ kind, alias })))
      .filter(({ alias }) => trimmed.toUpperCase().startsWith(`${alias.toUpperCase()} `)).sort((a, b) => b.alias.length - a.alias.length)[0];
    if (prefix) { name = prefix.alias; parameters = trimmed.slice(name.length).trim(); query = normalizeQuery(name); matches = [prefix.kind]; }
  }
  return matches.map((kind) => {
    const form = formFromSpec(KINDS[kind].defaults);
    if (kind === "ma" && ["EMA", "지수이평"].includes(query)) form.text.method = "ema";
    const fields = KINDS[kind].fields.filter((field) => field.type !== "method");
    const values = parameters === "" ? [] : parameters.split(/[\s,]+/);
    const errors: FieldError[] = values.length > fields.length ? [{ field: "", message: `숫자는 ${fields.length}개까지 입력하세요.` }] : [];
    values.slice(0, fields.length).forEach((value, i) => {
      const field = fields[i]!;
      form.text[field.key] = value;
      if (field.type === "optionalInt") form.enabled[field.key] = true;
      const valid = field.type === "float" ? Number(value) > 0 && Number.isFinite(Number(value)) : /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
      if (!valid) errors.push({ field: field.key, message: field.type === "float" ? "0보다 큰 수를 입력하세요." : "1부터 65535까지의 정수를 입력하세요." });
    });
    const spec = checkForm(form, null).spec;
    return { kind, label: spec ? specName(spec) : KINDS[kind].label, form, errors };
  });
}
