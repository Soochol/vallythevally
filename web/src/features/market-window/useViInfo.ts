import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { ViState } from "../../api/generated/ViState";
import { krxDayOpenQuery, krxReleaseBarsQuery, VI_RETRY_MS } from "../../api/userData";
import { formatBarTime } from "../../chart/time";
import { useViKnown } from "../../stores/symbolVi";
import type { ViInfo } from "./quoteInfo";
import type { TickRule } from "./tick";
import { releaseMinuteOpen, viBaseSource, viPricesOf } from "./viPrices";

export interface UseViInfoInput {
  readonly code: SymbolCode;
  readonly vi: ViState | null;
  readonly shown: boolean;
  readonly regularSession: boolean;
  readonly now: UnixSeconds;
  readonly tickRule: TickRule;
}

export function useViInfo({ code, vi, shown, regularSession, now, tickRule }: UseViInfoInput): ViInfo | null {
  const known = useViKnown();
  const source = viBaseSource(vi, known);
  const activeQuery = shown && regularSession;
  const releasedAt = source.kind === "releaseMinute" ? source.releasedAt : 0;
  const kstDate = formatBarTime(now, "D");
  const daySummary = useQuery({
    ...krxDayOpenQuery(code, kstDate),
    enabled: activeQuery && source.kind === "dayOpen",
  });
  const releaseBars = useQuery({
    ...krxReleaseBarsQuery(code, releasedAt),
    enabled: activeQuery && source.kind === "releaseMinute",
    refetchInterval: (query) => (query.state.data && releaseMinuteOpen(query.state.data, releasedAt) !== null ? false : VI_RETRY_MS),
  });
  if (!shown || !regularSession || !known) return null;
  const base =
    source.kind === "known"
      ? source.price
      : source.kind === "dayOpen"
        ? daySummary.data?.open ?? daySummary.data?.previousClose ?? null
        : source.kind === "releaseMinute"
          ? releaseBars.data ? releaseMinuteOpen(releaseBars.data, source.releasedAt) : null
          : null;
  const prices = base !== null && base > 0 ? viPricesOf(base, tickRule) : null;
  const triggered = vi !== null && vi.active && vi.direction !== null
    ? { direction: vi.direction, price: vi.triggerPrice }
    : null;
  return {
    up: prices?.up ?? null,
    down: prices?.down ?? null,
    triggered,
  };
}
