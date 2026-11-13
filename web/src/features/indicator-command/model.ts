import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { isFinancial, KINDS } from "../../chart/indicators/kinds";
import type { ChartSettings, IndicatorConfig } from "../../chart/settings";
import type { IndicatorCommandMode } from "../../stores/selection";
import type { SearchList } from "../search/searchList";
import { parseIndicatorInput, type IndicatorCandidate } from "./parseInput";

export type { IndicatorCommandMode };

export const COMMAND_TABS = [
  { mode: "current", label: "이 칸에 띄운 지표" },
  { mode: "add", label: "지표 추가" },
  { mode: "compare", label: "비교 종목" },
] as const satisfies readonly { mode: IndicatorCommandMode; label: string }[];

export const PRICE_GROUP = "가격 패널";
export const BELOW_GROUP = "아래 패널";
export const FINANCIAL_GROUP = "재무지표";
const GROUP_ORDER = [PRICE_GROUP, BELOW_GROUP, FINANCIAL_GROUP];

export type CommandRow = { kind: "current"; key: string; group: string; config: IndicatorConfig }
  | { kind: "candidate"; key: string; group: string; candidate: IndicatorCandidate }
  | { kind: "symbol"; key: string; group: string; info: SymbolInfo; selectable: boolean };

export function modeAfterInput(mode: IndicatorCommandMode, input: string): IndicatorCommandMode {
  return mode === "current" && input.trim() !== "" ? "add" : mode;
}

export function candidateGroup(candidate: IndicatorCandidate): string {
  const kind = KINDS[candidate.kind];
  if (isFinancial(kind.defaults)) return FINANCIAL_GROUP;
  return kind.place === "price" ? PRICE_GROUP : BELOW_GROUP;
}

export const currentKey = (id: string) => `current:${id}`;

const byGroup = (rows: CommandRow[]) => rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));

export function commandRows(settings: ChartSettings, input: string, mode: IndicatorCommandMode, symbols: SearchList): CommandRow[] {
  switch (mode) {
    case "current":
      return byGroup(settings.indicators.map((config) => ({ kind: "current", key: currentKey(config.id), group: config.panel === "price" ? PRICE_GROUP : BELOW_GROUP, config })));
    case "add":
      return byGroup(parseIndicatorInput(input).map((candidate) => ({ kind: "candidate", key: `new:${candidate.kind}:${input}`, group: candidateGroup(candidate), candidate })));
    case "compare":
      return symbols.rows.map(({ info }) => ({ kind: "symbol", key: `symbol:${info.code}`, group: "비교에 추가", info, selectable: symbols.selectable }));
  }
}

export function selectedRow(rows: readonly CommandRow[], chosen: string): CommandRow | undefined {
  return rows.find((row) => row.key === chosen && (row.kind !== "symbol" || row.selectable))
    ?? rows.find((row) => row.kind === "candidate" || row.kind === "current" || (row.kind === "symbol" && row.selectable));
}

export function commandKey(event: { key: string; shiftKey: boolean; isComposing: boolean }) {
  if (event.isComposing) return { kind: "ignore" } as const;
  if (event.key === "Enter") return { kind: "submit", close: event.shiftKey } as const;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") return { kind: "move", step: event.key === "ArrowDown" ? 1 : -1 } as const;
  return { kind: "ignore" } as const;
}
