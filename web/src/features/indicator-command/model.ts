import { isFinancial, isInvestorFlow, isQuote, isTickCvd, KINDS, type IndicatorKind } from "../../chart/indicators/kinds";
import type { ChartSettings } from "../../chart/settings";
import { parseIndicatorInput, type IndicatorCandidate } from "./parseInput";

export const PRICE_GROUP = "가격 위에 겹치는 지표";
export const BELOW_GROUP = "아래 패널에 그리는 지표";
export const QUOTE_GROUP = "호가지표";
export const FINANCIAL_GROUP = "재무지표";
const GROUP_ORDER = [PRICE_GROUP, BELOW_GROUP, QUOTE_GROUP, FINANCIAL_GROUP];

export const QUICK_MA_PERIODS = [5, 10, 20, 60, 120, 240] as const;

export type AddRow =
  | { kind: "candidate"; key: string; group: string; candidate: IndicatorCandidate }
  | { kind: "switch"; key: string; group: string; candidate: IndicatorCandidate; count: number };

export function indicatorPeriodBadge(kind: IndicatorKind): string | null {
  const spec = KINDS[kind].defaults;
  if (isFinancial(spec)) return "분기·연";
  if (isInvestorFlow(spec)) return "일봉+";
  if (isQuote(spec) || isTickCvd(spec)) return "분봉";
  return null;
}

export function candidateGroup(candidate: IndicatorCandidate): string {
  const kind = KINDS[candidate.kind];
  if (isQuote(kind.defaults)) return QUOTE_GROUP;
  if (isFinancial(kind.defaults)) return FINANCIAL_GROUP;
  return kind.place === "price" ? PRICE_GROUP : BELOW_GROUP;
}

function hasNumbers(input: string): boolean {
  const numeric = /^(.*?)([+-]?(?:\d|\.\d).*)$/.exec(input.trim());
  return numeric !== null && numeric[1]!.trim() !== "";
}

export function addRows(settings: Pick<ChartSettings, "indicators">, input: string): AddRow[] {
  const typed = hasNumbers(input);
  return parseIndicatorInput(input)
    .map((candidate): AddRow => {
      const group = candidateGroup(candidate);
      if (typed && KINDS[candidate.kind].fields.length > 0) return { kind: "candidate", key: `new:${candidate.kind}:${input}`, group, candidate };
      return { kind: "switch", key: `kind:${candidate.kind}`, group, candidate, count: settings.indicators.filter((item) => item.spec.kind === candidate.kind).length };
    })
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

export function stepRow(index: number, by: 1 | -1, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return by === 1 ? 0 : length - 1;
  return (index + by + length) % length;
}
