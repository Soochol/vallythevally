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
