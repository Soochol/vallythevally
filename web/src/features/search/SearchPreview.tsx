import { useQuery } from "@tanstack/react-query";
import type { BarsPage } from "../../api/generated/BarsPage";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { getJson } from "../../api/http";
import { usePublicMode } from "../../public-mode/serverMode";
import { KIND_LABEL, MARKET_LABEL } from "../../lib/symbol";
import { shownVenue } from "../../lib/venue";
import { useVenue } from "../../stores/ui";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";

export function QuoteValue({ quote, large = false }: { quote: Quote | undefined; large?: boolean }) {
  const color = quote && quote.changeRate > 0 ? "text-up" : quote && quote.changeRate < 0 ? "text-down" : "text-text-2";
  return <span className="flex items-baseline justify-end gap-2">
    <span className={`text-text ${large ? "text-h font-bold" : ""}`} aria-label="현재가">{quote ? quote.price.toLocaleString("ko-KR") : "—"}</span>
    <span className={`min-w-[60px] text-right font-semibold ${color}`} aria-label="등락률">{quote ? `${quote.changeRate > 0 ? "+" : ""}${quote.changeRate.toFixed(2)}%` : "—"}</span>
  </span>;
}

export function SearchPreview({ info, quote }: { info: SymbolInfo; quote: Quote | undefined }) {
  const venue = shownVenue(info.code, useVenue(), info);
  const publicMode = usePublicMode();
  const trend = useQuery({
    queryKey: ["search-trend", info.code, venue],
    queryFn: ({ signal }) => getJson<BarsPage>(`/api/bars?${new URLSearchParams({ symbol: info.code, period: "D", limit: "60", ...(venue === null ? {} : { venue }) })}`, signal),
    staleTime: 60_000,
    retry: false,
    enabled: !publicMode,
  });
  const bars = trend.data ? [...trend.data.bars, ...(trend.data.current ? [trend.data.current] : [])].slice(-60) : [];
  const values = bars.map((bar) => bar.c);
  const low = Math.min(...values);
  const range = Math.max(...values) - low || 1;
  const points = values.map((v, i) => `${4 + i * 252 / Math.max(1, values.length - 1)},${92 - (v - low) * 84 / range}`).join(" ");
  return <aside aria-label="종목 미리보기" className="w-[280px] flex-none space-y-4 overflow-y-auto border-l border-line p-4 max-md:hidden">
    <div><h3 className="text-l font-semibold">{info.name}</h3><p className="text-xs text-text-3">{info.code} · {MARKET_LABEL[info.market]} · {KIND_LABEL[info.kind]}</p></div>
    <QuoteValue quote={quote} large />
    <div className="rounded-m border border-line bg-chart-bg p-2"><p className="mb-2 text-xs text-text-3">60일 추세</p>
      {publicMode ? <EmptyState title="차트 연결은 준비 중입니다" /> : trend.isPending ? <Skeleton label="추세 불러오는 중" /> : trend.isError ? <ErrorState message="추세를 받지 못했습니다" retry={() => void trend.refetch()} /> : values.length === 0 ? <EmptyState title="일봉이 없습니다">다른 종목을 골라 보세요.</EmptyState> : <svg role="img" aria-label={`${info.name} 60일 추세`} viewBox="0 0 260 100" className={`w-full ${values.at(-1)! >= values[0]! ? "text-up" : "text-down"}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
    </div>
  </aside>;
}
