import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ApiRequestError } from "../api/http";
import { fetchSymbolInfo } from "../api/queries";
import { isPeriodOn } from "../lib/symbol";
import { useLayoutStore } from "../stores/layout";
import { useSelectionStore } from "../stores/selection";

/**
 * `/?symbol=005930&period=D`로 활성 칸을 연다. 없는 종목이면 칸은 그대로 두고
 * 아래 알림을 띄운다(frontend.md §3.7a). 읽은 뒤에는 주소에서 지운다.
 */
export function useOpenFromAddress() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const symbol = params.get("symbol");
  const period = params.get("period");

  useEffect(() => {
    if (symbol === null && period === null) return;
    const slot = useSelectionStore.getState().activeSlot;
    const { setSymbol, setPeriod } = useLayoutStore.getState();
    setParams({}, { replace: true });
    if (period !== null && isPeriodOn(period)) setPeriod(slot, period);
    if (symbol === null) return;
    queryClient
      .fetchQuery({ queryKey: ["symbol", symbol], queryFn: ({ signal }) => fetchSymbolInfo(symbol, signal), staleTime: Infinity })
      .then(
        () => setSymbol(slot, symbol),
        (e: unknown) => {
          if (e instanceof ApiRequestError && e.code === "unknown_symbol") {
            useSelectionStore.getState().showToast(`주소의 종목 ${symbol}를 찾을 수 없습니다`);
          } else {
            // 서버가 아직 종목 목록을 못 받았을 수 있다. 칸이 열면서 오류를 보인다.
            setSymbol(slot, symbol);
          }
        },
      );
  }, [symbol, period, setParams, queryClient]);
}
