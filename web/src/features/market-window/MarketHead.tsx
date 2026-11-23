import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { useSymbolInfo } from "../../api/queries";
import { daySummaryQueryKey, fetchDaySummary } from "../../api/userData";
import { isMarketOpen } from "../../chart/time";
import { useNowMs } from "../book/useNowMs";
import { SymbolHead } from "./SymbolHead";

export function useDayQuote(code: SymbolCode, venue: Venue) {
  const summary = useQuery({ queryKey: daySummaryQueryKey(code, venue), queryFn: ({ signal }) => fetchDaySummary(code, venue, signal), staleTime: 60_000 });
  return { price: summary.data?.price ?? null, previousClose: summary.data?.previousClose ?? null };
}

interface Props {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly lastPrice?: number | null;
  readonly previousClose?: number | null;
}

export function MarketHead({ code, venue, lastPrice, previousClose }: Props) {
  const name = useSymbolInfo(code).data?.name ?? null;
  const quote = useDayQuote(code, venue);
  const now = useNowMs();
  return (
    <SymbolHead code={code} name={name} lastPrice={lastPrice ?? quote.price} previousClose={previousClose ?? quote.previousClose}
      marketOpen={isMarketOpen(Math.floor(now / 1000))} mock={false} testIdPrefix="market-symbol" />
  );
}
