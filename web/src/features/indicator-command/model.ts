import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { isFinancial, isQuote, KINDS } from "../../chart/indicators/kinds";
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

export const INDICATOR_DIALOG_TABS = [
  { mode: "current", label: "이 칸에 띄운 지표" },
  { mode: "add", label: "지표 추가" },
] as const satisfies readonly { mode: IndicatorCommandMode; label: string }[];

export type AddCategory = "all" | "price" | "panel" | "quote" | "fin";

export const ADD_CATEGORIES = [
  { id: "all", label: "전체" },
  { id: "price", label: "가격" },
  { id: "panel", label: "아래" },
  { id: "quote", label: "호가" },
  { id: "fin", label: "재무" },
] as const satisfies readonly { id: AddCategory; label: string }[];

export const MA_GROUP_KEY = "current:ma-group";

export type CommandHint = { keys: string; action: string };

export function commandHints(mode: IndicatorCommandMode): readonly CommandHint[] {
  if (mode === "current") return [{ keys: "↑↓", action: "고르기" }, { keys: "Tab", action: "설정" }, { keys: "Esc", action: "되돌리고 닫기" }];
  if (mode === "compare") return [{ keys: "↑↓", action: "고르기" }, { keys: "Enter", action: "추가하고 계속" }, { keys: "Shift+Enter", action: "추가하고 닫기" }, { keys: "Esc", action: "되돌리고 닫기" }];
  return [{ keys: "↑↓", action: "고르기" }, { keys: "Tab", action: "설정" }, { keys: "Enter", action: "추가하고 계속" }, { keys: "Shift+Enter", action: "추가하고 닫기" }, { keys: "Esc", action: "되돌리고 닫기" }];
}

export const PRICE_GROUP = "가격 패널";
export const BELOW_GROUP = "아래 패널";
export const QUOTE_GROUP = "호가지표";
export const FINANCIAL_GROUP = "재무지표";
const GROUP_ORDER = [PRICE_GROUP, BELOW_GROUP, QUOTE_GROUP, FINANCIAL_GROUP];

export type CommandRow = { kind: "current"; key: string; group: string; config: IndicatorConfig }
  | { kind: "candidate"; key: string; group: string; candidate: IndicatorCandidate }
  | { kind: "symbol"; key: string; group: string; info: SymbolInfo; selectable: boolean };

export type DialogRow = CommandRow | { kind: "maGroup"; key: typeof MA_GROUP_KEY; group: typeof PRICE_GROUP; lines: IndicatorConfig[] };

export function matchesCategory(group: string, category: AddCategory): boolean {
  if (category === "all") return true;
  if (category === "price") return group === PRICE_GROUP;
  if (category === "panel") return group === BELOW_GROUP;
  if (category === "quote") return group === QUOTE_GROUP;
  return group === FINANCIAL_GROUP;
}

export function groupDialogRows(rows: readonly CommandRow[], mode: IndicatorCommandMode, category: AddCategory, hasQuery: boolean): DialogRow[] {
  if (mode === "add") {
    return hasQuery || category === "all" ? [...rows] : rows.filter((row) => matchesCategory(row.group, category));
  }
  if (mode !== "current") return [...rows];
  const maLines = rows.filter((row): row is Extract<CommandRow, { kind: "current" }> => row.kind === "current" && row.config.spec.kind === "ma").map((row) => row.config);
  const rest = rows.filter((row) => !(row.kind === "current" && row.config.spec.kind === "ma"));
  if (maLines.length === 0) return rest;
  return [{ kind: "maGroup", key: MA_GROUP_KEY, group: PRICE_GROUP, lines: maLines }, ...rest];
}

export function selectedDialogRow(rows: readonly DialogRow[], chosen: string): DialogRow | undefined {
  const direct = rows.find((row) => row.key === chosen && (row.kind !== "symbol" || row.selectable));
  if (direct) return direct;
  if (chosen.startsWith("current:")) {
    const id = chosen.slice("current:".length);
    const maGroup = rows.find((row) => row.kind === "maGroup" && row.lines.some((line) => line.id === id));
    if (maGroup) return maGroup;
  }
  return rows.find((row) => row.kind === "maGroup" || row.kind === "candidate" || row.kind === "current" || (row.kind === "symbol" && row.selectable));
}

export function modeAfterInput(mode: IndicatorCommandMode, input: string): IndicatorCommandMode {
  return mode === "current" && input.trim() !== "" ? "add" : mode;
}

export function candidateGroup(candidate: IndicatorCandidate): string {
  const kind = KINDS[candidate.kind];
  if (isQuote(kind.defaults)) return QUOTE_GROUP;
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
