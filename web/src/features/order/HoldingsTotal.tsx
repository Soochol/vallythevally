import { memo, useCallback, useSyncExternalStore } from "react";
import type { TradingBalance } from "../../api/generated/TradingBalance";
import type { TradingHolding } from "../../api/generated/TradingHolding";
import { formatPercent } from "../../lib/format";
import { quoteBook } from "../../stores/realtime";
import { subscribeBatched } from "../../stores/watchQuotes";
import { compactProfitText } from "./compactProfit";
import { liveWatchPrice, profitTone, signedWonText } from "./holdingSummary";
import { creditHoldingsOf, liveTotalProfit, totalProfitRate } from "./liveTotal";

const noopUnsubscribe = (): void => undefined;

function watchedCodesKey(balance: TradingBalance, activeCode: string | null): string {
  const seen = new Set<string>();
  for (const holding of balance.holdings) if (holding.code !== activeCode) seen.add(holding.code);
  for (const holding of creditHoldingsOf(balance)) if (holding.code !== activeCode) seen.add(holding.code);
  return [...seen].join("\0");
}

interface Props {
  readonly balance: TradingBalance;
  readonly activeHolding: TradingHolding | null;
  readonly count: number;
  readonly labelId: string;
}

export const HoldingsTotal = memo(function HoldingsTotal({ balance, activeHolding, count, labelId }: Props) {
  const activeCode = activeHolding?.code ?? null;
  const activePrice = activeHolding?.currentPrice ?? null;
  const watchedKey = watchedCodesKey(balance, activeCode);
  const subscribe = useCallback(
    (listener: () => void) => (watchedKey === "" ? noopUnsubscribe : subscribeBatched(quoteBook, watchedKey.split("\0"), listener)),
    [watchedKey],
  );
  const priceOf = useCallback(
    (code: string): number | null => {
      if (activeCode !== null && code === activeCode) return activePrice;
      return liveWatchPrice(quoteBook.get(code));
    },
    [activeCode, activePrice],
  );
  const totalProfit = useSyncExternalStore(subscribe, () => liveTotalProfit(balance, priceOf));
  const rate = totalProfitRate(totalProfit, balance.totalPurchase);
  const rateText = rate === null ? null : formatPercent(rate);
  const wonText = signedWonText(totalProfit);
  const compactText = compactProfitText(totalProfit);
  const fullText = rateText === null ? wonText : `${rateText} ${wonText}`;
  return (
    <>
      <span className="od-tab-sep" aria-hidden="true"> · </span>
      <span className="od-tab-total" data-testid="account-total-profit" data-tone={profitTone(totalProfit)}>
        {rateText !== null && `${rateText} `}
        <span className="od-tab-full">{wonText}</span>
        <span className="od-tab-short">{compactText}</span>
      </span>
      <span id={labelId} hidden>{`보유종목 ${count}, 총평가손익 ${fullText}`}</span>
    </>
  );
});
