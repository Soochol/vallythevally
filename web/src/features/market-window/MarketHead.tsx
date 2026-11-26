import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { useSymbolInfo } from "../../api/queries";
import { daySummaryQueryKey, fetchDaySummary } from "../../api/userData";
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
  readonly nxtBadge?: boolean;
  readonly trailing?: ReactNode;
}

export function MarketHead({ code, venue, lastPrice, previousClose, nxtBadge = false, trailing }: Props) {
  const info = useSymbolInfo(code).data;
  const quote = useDayQuote(code, venue);
  return (
    <SymbolHead code={code} name={info?.name ?? null} lastPrice={lastPrice ?? quote.price} previousClose={previousClose ?? quote.previousClose}
      nxtTraded={nxtBadge && info?.nxtEnabled === true} mock={false} testIdPrefix="market-symbol" trailing={trailing} />
  );
}
