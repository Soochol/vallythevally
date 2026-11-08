import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { ApiRequestError } from "../../api/http";

export interface CellErrorView {
  text: string;
  action: "search" | "retry" | null;
}

/** 칸을 열다 난 오류를 칸 가운데 문장과 버튼으로 바꾼다(frontend.md §3.7a). */
export function cellErrorView(error: ApiRequestError, symbol: SymbolCode): CellErrorView {
  switch (error.code) {
    case "unknown_symbol":
      return { text: `종목 ${symbol}을 찾을 수 없습니다. 상장 폐지되었거나 코드가 바뀌었을 수 있습니다.`, action: "search" };
    case "kiwoom_auth_failed":
      // 운영자가 서버 설정을 고쳐야 한다. 다시 시도해도 같다.
      return { text: error.message, action: null };
    default:
      return { text: error.message, action: "retry" };
  }
}

export interface OlderErrorView {
  text: string;
  retry: boolean;
}

/** 과거 페이지를 받다 난 오류. 가진 봉은 그대로 두고 칸 왼쪽 끝에 이유를 적는다. */
export function olderErrorView(error: ApiRequestError, symbol: SymbolCode): OlderErrorView {
  return { text: `과거 봉을 받지 못했습니다. ${error.message}`, retry: cellErrorView(error, symbol).action === "retry" };
}
