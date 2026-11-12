import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { SearchCommand } from "../commands/registry";
import { highlight, normalizeQuery } from "./highlight";

export type MarketFilter = "all" | "kospi" | "kosdaq" | "etf";
export const MARKET_FILTERS = [
  { value: "all", label: "전체" }, { value: "kospi", label: "코스피" },
  { value: "kosdaq", label: "코스닥" }, { value: "etf", label: "ETF" },
] satisfies { value: MarketFilter; label: string }[];

export function searchMode(input: string) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(">")
    ? { kind: "commands", query: normalizeQuery(trimmed.slice(1)) } as const
    : { kind: "symbols", query: normalizeQuery(input) } as const;
}

export const matchesMarket = (info: SymbolInfo, filter: MarketFilter) =>
  filter === "all" || (filter === "etf" ? info.kind === "etf" : info.market === filter);

export function matchingCommands(commands: readonly SearchCommand[], query: string): readonly SearchCommand[] {
  return commands.filter((command) => query === "" || [command.label, command.keywords ?? ""].some((text) => highlight(text, query).some((s) => s.match)));
}
