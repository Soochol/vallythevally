import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { ChartSettings, IndicatorConfig } from "../../chart/settings";
import type { SearchList } from "../search/searchList";
import { parseIndicatorInput, type IndicatorCandidate } from "./parseInput";

export type CommandRow = { kind: "current"; key: string; group: string; config: IndicatorConfig }
  | { kind: "candidate"; key: string; group: string; candidate: IndicatorCandidate }
  | { kind: "symbol"; key: string; group: string; info: SymbolInfo; selectable: boolean };

export function commandRows(settings: ChartSettings, input: string, mode: "indicators" | "compare", symbols: SearchList): CommandRow[] {
  return [
    ...(mode === "indicators" ? settings.indicators.map((config): CommandRow => ({ kind: "current", key: `current:${config.id}`, group: "이 칸에 띄운 지표", config })) : []),
    ...(mode === "indicators" ? parseIndicatorInput(input).map((candidate): CommandRow => ({ kind: "candidate", key: `new:${candidate.kind}:${input}`, group: "지표 추가", candidate })) : []),
    ...(mode === "compare" || input.trim() !== "" ? symbols.rows.map(({ info }): CommandRow => ({ kind: "symbol", key: `symbol:${info.code}`, group: "비교에 추가", info, selectable: symbols.selectable })) : []),
  ];
}

export function selectedRow(rows: readonly CommandRow[], chosen: string): CommandRow | undefined {
  return rows.find((row) => row.key === chosen && (row.kind !== "symbol" || row.selectable))
    ?? rows.find((row) => row.kind === "candidate" || (row.kind === "symbol" && row.selectable));
}

export function commandKey(event: { key: string; shiftKey: boolean; isComposing: boolean }) {
  if (event.isComposing) return { kind: "ignore" } as const;
  if (event.key === "Enter") return { kind: "submit", close: event.shiftKey } as const;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") return { kind: "move", step: event.key === "ArrowDown" ? 1 : -1 } as const;
  return { kind: "ignore" } as const;
}
