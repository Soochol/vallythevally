import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Bar } from "../../api/generated/Bar";
import type { BarsPage } from "../../api/generated/BarsPage";
import type { ScreenerRow } from "../../api/generated/ScreenerRow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { getJson } from "../../api/http";
import { direction, formatPercent, formatPrice } from "../../lib/format";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";

export const resultBarsQuery = (symbol: SymbolCode) => queryOptions({
  queryKey: ["screener-preview", symbol],
  queryFn: ({ signal }) => getJson<BarsPage>(`/api/bars?${new URLSearchParams({ symbol, venue: "krx", period: "D", limit: "60" })}`, signal),
  staleTime: 60_000,
  retry: false,
});

export function MiniChart({ bars, name }: { bars: readonly Bar[]; name: string }) {
  if (bars.length === 0) return <EmptyState title="일봉이 없습니다">다른 결과 종목을 골라 보세요.</EmptyState>;
  const low = Math.min(...bars.map((bar) => bar.l));
  const range = Math.max(...bars.map((bar) => bar.h)) - low || 1;
  const y = (price: number) => 148 - (price - low) * 136 / range;
  const step = 280 / bars.length;
  return <svg role="img" aria-label={`${name} KRX 일봉 미니 차트`} viewBox="0 0 300 160" className="w-full">
    {bars.map((bar, i) => {
      const x = 10 + (i + 0.5) * step;
      return <g key={bar.t} className={bar.c >= bar.o ? "text-up" : "text-down"}>
        <line x1={x} x2={x} y1={y(bar.h)} y2={y(bar.l)} stroke="currentColor" />
        <rect x={x - step * 0.3} y={Math.min(y(bar.o), y(bar.c))} width={step * 0.6} height={Math.max(1, Math.abs(y(bar.o) - y(bar.c)))} fill="currentColor" />
      </g>;
    })}
  </svg>;
}

export function ResultPreview({ row, onOpen, onCompare }: { row: ScreenerRow; onOpen(): void; onCompare(): void }) {
  const query = useQuery(resultBarsQuery(row.symbol));
  const bars = query.data ? [...query.data.bars, ...(query.data.current ? [query.data.current] : [])].slice(-60) : [];
  const color = row.changeRate === null ? "text-text-2" : { up: "text-up", down: "text-down", flat: "text-text-2" }[direction(row.changeRate)];
  return <aside aria-label="결과 종목 미리보기" className="flex min-h-0 min-w-0 flex-col border-l border-line bg-bg">
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <div><h3 className="text-l font-semibold">{row.name}</h3><p className="text-xs text-text-3">{row.symbol} · KRX</p></div>
      <div className={`flex flex-wrap items-baseline gap-2 tabular-nums ${color}`}><b className="text-l">{formatPrice(row.close, false)}</b><span>{row.changeRate === null ? "—" : formatPercent(row.changeRate)}</span></div>
      <p className="text-xs text-text-3">실행 결과 종가 · {row.latestBarDate}{row.provisional && " · 잠정"}</p>
      <div className="rounded-m border border-line bg-chart-bg p-2"><p className="mb-2 text-xs text-text-3">KRX 일봉 · 최근 60봉</p>
        {query.isPending ? <Skeleton label="일봉 불러오는 중" /> : query.isError ? <ErrorState message="일봉을 받지 못했습니다" retry={() => void query.refetch()} /> : <MiniChart bars={bars} name={row.name} />}
      </div>
      <dl className="text-s"><dt className="text-text-3">첫 봉 조건 충족일</dt><dd className="mt-1 tabular-nums">{row.matchedDate}</dd></dl>
      <p className="text-xs text-text-3">차트는 최신 조회 자료이며 실행 결과의 수집 시각과 다를 수 있습니다.</p>
    </div>
    <div className="flex flex-none flex-wrap gap-2 border-t border-line p-3">
      <button type="button" data-chart-control className="btn-primary flex h-[var(--size-30)] flex-1 items-center justify-center gap-2 whitespace-nowrap px-2 text-s" onClick={() => onOpen()}>칸에 열기 <kbd>↵</kbd></button>
      <button type="button" data-chart-control className="tb-btn whitespace-nowrap text-s" onClick={onCompare}>비교에 추가</button>
    </div>
  </aside>;
}
