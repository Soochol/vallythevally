import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ApiRequestError } from "../api/http";
import { fetchSymbolInfo } from "../api/queries";
import { isPeriod } from "../lib/symbol";
import { isVenue, venueFor, type VenueTarget } from "../lib/venue";
import { useLayoutStore } from "../stores/layout";
import { useSelectionStore } from "../stores/selection";

/**
 * `/?symbol=005930&venue=krx&period=5m`로 활성 칸을 연다. 없는 종목이면 칸은 그대로 두고
 * 아래 알림을 띄운다(frontend.md §3.7a). 읽은 뒤에는 주소에서 지운다.
 * venue가 없거나 모르는 값이면 통합이다. 지수면 venue를 무시한다. venue는 symbol과 함께일 때만 읽는다.
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
    const { setSymbol, setPeriod } = useLayoutStore.getState();
    const venue = venueParam !== null && isVenue(venueParam) ? venueParam : "combined";
    setParams({}, { replace: true });
    // 종목과 봉 주기를 한 번에 바꾼다. 따로 바꾸면 지금 종목의 새 봉 주기를 쓸데없이 한 번 더 받는다.
    const open = (target: VenueTarget | null) => {
      if (period !== null && isPeriod(period)) setPeriod(cellId, period);
      if (target !== null) setSymbol(cellId, target, venue);
    };
    if (symbol === null) return open(null);
    queryClient
      .fetchQuery({ queryKey: ["symbol", symbol], queryFn: ({ signal }) => fetchSymbolInfo(symbol, signal), staleTime: Infinity })
      .then(
        (info) => {
          if (venue === "nxt" && venueFor(info, venue) === "combined") {
            useSelectionStore.getState().showToast("NXT에서 거래되지 않아 통합으로 엽니다");
          }
          open(info);
        },
        (e: unknown) => {
          if (e instanceof ApiRequestError && e.code === "unknown_symbol") {
            useSelectionStore.getState().showToast(`주소의 종목 ${symbol}를 찾을 수 없습니다`);
          } else {
            // 서버가 아직 종목 목록을 못 받았을 수 있다. 칸이 열면서 오류를 보인다.
            // NXT를 고를 수 있는지 모르므로 NXT를 바랐으면 통합으로 연다.
            open({ code: symbol, nxtEnabled: false });
          }
        },
      );
  }, [symbol, venueParam, period, setParams, queryClient]);
}
