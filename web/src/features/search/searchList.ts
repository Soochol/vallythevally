import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { SearchResult } from "../../api/queries";

export interface SearchList {
  rows: SymbolInfo[];
  /** 행을 Enter나 클릭으로 열 수 있는가. 이전 검색어의 결과가 남아 있는 동안은 거짓이다. */
  selectable: boolean;
  recent: boolean;
}

/** 대화상자에 보일 목록. 결과는 그 결과의 검색어가 지금 입력과 같을 때만 고를 수 있다. */
export function searchList(query: string, recent: SymbolInfo[], result: SearchResult | undefined): SearchList {
  if (query === "") return { rows: recent, selectable: true, recent: true };
  return { rows: result?.rows ?? [], selectable: result?.q === query, recent: false };
}
