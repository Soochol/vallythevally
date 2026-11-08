import type { BarsPage } from "./generated/BarsPage";
import type { Period } from "./generated/Period";
import type { SymbolCode } from "./generated/SymbolCode";
import type { UnixSeconds } from "./generated/UnixSeconds";
import { getJson } from "./http";

export interface BarsQuery {
  symbol: SymbolCode;
  period: Period;
  /** 없으면 최신 페이지. */
  before?: UnixSeconds;
}

/** `GET /api/bars`. 봉은 React Query가 아니라 칸의 컨트롤러가 갖는다(frontend.md §5.2). */
export function fetchBarsPage(q: BarsQuery, signal?: AbortSignal): Promise<BarsPage> {
  const params = new URLSearchParams({ symbol: q.symbol, period: q.period, limit: "500" });
  if (q.before !== undefined) params.set("before", String(q.before));
  return getJson<BarsPage>(`/api/bars?${params}`, signal);
}
