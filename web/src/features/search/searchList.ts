import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { SearchResult } from "../../api/queries";

export type SearchGroup = "watch" | "recent" | "result";

export interface SearchRow {
  info: SymbolInfo;
  group: SearchGroup;
}

export interface SearchList {
  rows: SearchRow[];
  /** 행을 Enter나 클릭으로 열 수 있는가. 이전 검색어의 결과가 남아 있는 동안은 거짓이다. */
  selectable: boolean;
  /** 빈 입력이라 관심종목과 최근 본 종목을 보이는 중이다. */
  empty: boolean;
}

export const GROUP_LABEL: Record<SearchGroup, string> = { watch: "관심종목", recent: "최근 본 종목", result: "검색 결과" };

/**
 * 대화상자에 보일 목록(frontend.md §3.1). 빈 입력이면 관심종목(목록 순서), 최근 본 종목(최근 것 먼저) 두 묶음.
 * 결과는 그 결과의 검색어가 지금 입력과 같을 때만 고를 수 있다.
 */
export function searchList(
  query: string,
  empty: { watch: SymbolInfo[]; recent: SymbolInfo[] },
  result: SearchResult | undefined,
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
    selectable: result?.q === query,
    empty: false,
  };
}
