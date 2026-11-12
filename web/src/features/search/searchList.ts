import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { SearchResult, SymbolSearchFilters } from "../../api/queries";

export type SearchGroup = "watch" | "recent" | "result";

export interface SearchRow {
  info: SymbolInfo;
  group: SearchGroup;
}

export interface SearchList {
  rows: SearchRow[];
  /** 행을 Enter나 클릭으로 열 수 있는가. 이전 검색어의 결과가 남아 있는 동안은 거짓이다. */
  selectable: boolean;
  empty: boolean;
}

export const GROUP_LABEL: Record<SearchGroup, string> = { watch: "관심종목", recent: "최근 본 종목", result: "검색 결과" };

export function searchList(
  query: string,
  empty: { watch: SymbolInfo[]; recent: SymbolInfo[] },
  result: SearchResult | undefined,
  filters: SymbolSearchFilters = {},
): SearchList {
  if (query === "") {
    const rows = [
      ...empty.watch.map((info): SearchRow => ({ info, group: "watch" })),
      ...empty.recent.map((info): SearchRow => ({ info, group: "recent" })),
    ];
    return { rows, selectable: true, empty: true };
  }
  return {
    rows: (result?.rows ?? []).map((info) => ({ info, group: "result" })),
    selectable: result?.q === query && result.filters.market === filters.market && result.filters.kind === filters.kind,
    empty: false,
  };
}
