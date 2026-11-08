import type { BarsPage } from "./generated/BarsPage";
import type { Period } from "./generated/Period";
import type { SymbolCode } from "./generated/SymbolCode";
import type { UnixSeconds } from "./generated/UnixSeconds";
import type { Venue } from "./generated/Venue";
import { getJson } from "./http";

/** 칸 하나가 그리는 봉 열. 이것이 바뀌면 시리즈 세대를 올린다(D1). */
export interface SeriesKey {
  symbol: SymbolCode;
  /** 지수면 null이고 요청에 넣지 않는다. 주식은 언제나 보낸다. */
  venue: Venue | null;
  period: Period;
}

export interface BarsQuery extends SeriesKey {
  /** 없으면 최신 페이지. */
  before?: UnixSeconds;
}

/** `GET /api/bars`. 봉은 React Query가 아니라 칸의 컨트롤러가 갖는다(frontend.md §5.2). */
export function fetchBarsPage(q: BarsQuery, signal?: AbortSignal): Promise<BarsPage> {
  const params = new URLSearchParams({ symbol: q.symbol, period: q.period, limit: "500" });
  if (q.venue !== null) params.set("venue", q.venue);
  if (q.before !== undefined) params.set("before", String(q.before));
  return getJson<BarsPage>(`/api/bars?${params}`, signal);
}
