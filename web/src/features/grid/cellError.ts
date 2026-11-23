import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { ApiRequestError } from "../../api/http";

export type CellAction = "search" | "retry" | "systemSettings";

export interface CellErrorView {
  title: string;
  detail: string | null;
  actions: readonly CellAction[];
}

export function cellErrorView(error: ApiRequestError, symbol: SymbolCode): CellErrorView {
  if (error.code === "unknown_symbol") {
    return { title: `종목 ${symbol}을 찾을 수 없습니다`, detail: "상장 폐지되었거나 코드가 바뀌었을 수 있습니다.", actions: ["search"] };
  }
  if (error.manualActionRequired) {
    return { title: "조회가 멈췄습니다", detail: error.message, actions: ["systemSettings"] };
  }
  return { title: "차트를 불러오지 못했습니다", detail: error.message, actions: ["retry"] };
}

export interface OlderErrorView {
  text: string;
  retry: boolean;
}

export function olderErrorView(error: ApiRequestError, symbol: SymbolCode): OlderErrorView {
  return { text: `과거 봉을 받지 못했습니다. ${error.message}`, retry: cellErrorView(error, symbol).actions.includes("retry") };
}
