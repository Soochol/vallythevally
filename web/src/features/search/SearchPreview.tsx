import { useQuery } from "@tanstack/react-query";
import type { BarsPage } from "../../api/generated/BarsPage";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { getJson } from "../../api/http";
import { KIND_LABEL, MARKET_LABEL } from "../../lib/symbol";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";

export function QuoteValue({ quote, large = false }: { quote: Quote | undefined; large?: boolean }) {
  const color = quote && quote.changeRate > 0 ? "text-up" : quote && quote.changeRate < 0 ? "text-down" : "text-text-2";
  return <span className={`flex items-baseline justify-end gap-2 ${color}`}>
    <span className={large ? "text-[24px] font-bold" : "text-text"} aria-label="현재가">{quote ? quote.price.toLocaleString("ko-KR") : "—"}</span>
    <span className="min-w-[60px] text-right font-semibold" aria-label="등락률">{quote ? `${quote.changeRate > 0 ? "+" : ""}${quote.changeRate.toFixed(2)}%` : "—"}</span>
  </span>;
}

export function SearchPreview({ info, quote }: { info: SymbolInfo; quote: Quote | undefined }) {
  const trend = useQuery({
    queryKey: ["search-trend", info.code],
    queryFn: ({ signal }) => getJson<BarsPage>(`/api/bars?${new URLSearchParams({ symbol: info.code, period: "D", limit: "60", ...(info.kind === "index" ? {} : { venue: "combined" }) })}`, signal),
    staleTime: 60_000,
    retry: false,
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
      {trend.isPending ? <Skeleton label="추세 불러오는 중" /> : trend.isError ? <ErrorState message="추세를 받지 못했습니다" retry={() => void trend.refetch()} /> : values.length === 0 ? <EmptyState title="일봉이 없습니다">다른 종목을 골라 보세요.</EmptyState> : <svg role="img" aria-label={`${info.name} 60일 추세`} viewBox="0 0 260 100" className={`w-full ${values.at(-1)! >= values[0]! ? "text-up" : "text-down"}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
    </div>
    <div className="space-y-2 border-t border-line pt-4 text-xs text-text-2"><p><kbd>↵</kbd> 이 칸에 열기</p><p><kbd>Ctrl+↵</kbd> 관심종목 넣기·빼기</p><p><kbd>Shift+↵</kbd> 비교에 추가</p></div>
  </aside>;
}
