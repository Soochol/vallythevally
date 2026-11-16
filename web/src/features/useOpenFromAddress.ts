import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ApiRequestError } from "../api/http";
import { fetchSymbolInfo } from "../api/queries";
import { isPeriod } from "../lib/symbol";
import { isVenue } from "../lib/venue";
import { type SymbolTarget, useLayoutStore } from "../stores/layout";
import { useSelectionStore } from "../stores/selection";
import { useUiStore } from "../stores/ui";

/**
 * `/?symbol=005930&venue=krx&period=5m`로 활성 칸을 연다. 없는 종목이면 칸은 그대로 두고
 * 아래 알림을 띄운다(frontend.md §3.7a). 읽은 뒤에는 주소에서 지운다.
 * venue는 앱 전체 거래소를 바꾼다. 없거나 모르는 값이면 건드리지 않는다. venue는 symbol과 함께일 때만 읽는다.
 */
export function useOpenFromAddress() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const symbol = params.get("symbol");
  const venueParam = params.get("venue");
  const period = params.get("period");

  useEffect(() => {
    if (symbol === null && venueParam === null && period === null) return;
    const cellId = useSelectionStore.getState().activeCell;
    const session = useLayoutStore.getState().session;
    const { setSymbol, setPeriod } = useLayoutStore.getState();
    setParams({}, { replace: true });
    // 종목과 봉 주기를 한 번에 바꾼다. 따로 바꾸면 지금 종목의 새 봉 주기를 쓸데없이 한 번 더 받는다.
    const open = (target: SymbolTarget | null) => {
      if (useLayoutStore.getState().session !== session) return;
      if (period !== null && isPeriod(period)) setPeriod(cellId, period);
      if (target !== null && venueParam !== null && isVenue(venueParam)) useUiStore.getState().setVenue(venueParam);
      const notice = target === null ? null : setSymbol(cellId, target).notice;
      if (notice) useSelectionStore.getState().showToast(notice);
    };
    if (symbol === null) return open(null);
    queryClient
      .fetchQuery({ queryKey: ["symbol", symbol], queryFn: ({ signal }) => fetchSymbolInfo(symbol, signal), staleTime: Infinity })
      .then(
        open,
        (e: unknown) => {
          if (e instanceof ApiRequestError && e.code === "unknown_symbol") {
            useSelectionStore.getState().showToast(`주소의 종목 ${symbol}를 찾을 수 없습니다`);
          } else {
            // 서버가 아직 종목 목록을 못 받았을 수 있다. 칸이 열면서 오류를 보인다.
            open({ code: symbol });
          }
        },
      );
  }, [symbol, venueParam, period, setParams, queryClient]);
}
