import { queryOptions, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { fetchBarsPage } from "../../api/bars";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { CANDLE_STRIP_HEIGHT, CANDLE_STRIP_WIDTH, candleShapes, DAILY_CANDLE_LIMIT, recentDailyBars } from "./dailyCandles";

const DAILY_BARS_STALE_MS = 5 * 60_000;
const DAILY_BARS_GC_MS = 15 * 60_000;
const LAZY_ROOT_MARGIN = "160px 0px";

export const dailyMiniBarsQuery = (symbol: SymbolCode, venue: Venue) =>
  queryOptions({
    queryKey: ["heatmap-daily-bars", symbol, venue, DAILY_CANDLE_LIMIT],
    queryFn: ({ signal }) => fetchBarsPage({ symbol, venue, period: "D", limit: DAILY_CANDLE_LIMIT }, signal),
    staleTime: DAILY_BARS_STALE_MS,
    gcTime: DAILY_BARS_GC_MS,
    retry: false,
  });

function useNearViewport(target: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !target.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      { rootMargin: LAZY_ROOT_MARGIN },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [seen, target]);
  return seen;
}

interface Props {
  code: SymbolCode;
  name: string;
  venue: Venue;
  livePrice: number | null;
}

export const DailyCandleStrip = memo(function DailyCandleStrip({ code, name, venue, livePrice }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const visible = useNearViewport(host);
  const query = useQuery({ ...dailyMiniBarsQuery(code, venue), enabled: visible });
  const shapes = useMemo(() => candleShapes(recentDailyBars(query.data, livePrice)), [query.data, livePrice]);
  return (
    <span ref={host} className="hm-candle-slot">
      {shapes.length === 0 ? (
        <span className="hm-candle-empty" aria-hidden="true" />
      ) : (
        <svg
          className="hm-candle-svg"
          viewBox={`0 0 ${CANDLE_STRIP_WIDTH} ${CANDLE_STRIP_HEIGHT}`}
          role="img"
          aria-label={`${name} 최근 일봉 ${shapes.length}개`}
        >
          {shapes.map((shape) => (
            <g key={shape.t} className="hm-candle" data-side={shape.side}>
              <line className="hm-candle-wick" x1={shape.x} x2={shape.x} y1={shape.wickTop} y2={shape.wickBottom} />
              <rect className="hm-candle-body" x={shape.bodyX} y={shape.bodyY} width={shape.bodyWidth} height={shape.bodyHeight} rx={0.5} />
            </g>
          ))}
        </svg>
      )}
    </span>
  );
});
