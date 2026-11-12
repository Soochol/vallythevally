import { useEffect, useState } from "react";
import { formatKstClockSeconds, isMarketOpen } from "../../chart/time";
import { serverNow, useServerClock } from "../../stores/serverClock";

export function MarketClock() {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [now, setNow] = useState(() => serverNow(origin) / 1000);
  useEffect(() => {
    const tick = () => setNow(serverNow(origin) / 1000);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [origin]);
  return <span aria-label="장 상태와 서버 시계" title="서버 기준 한국 시각 · 평일 08:00~20:00 장 상태 (공휴일 제외 여부는 확인하지 않음)" className="flex-none text-text-3">
    {isMarketOpen(now) ? "장중" : "장 마감"} · <time>{formatKstClockSeconds(now)}</time>
  </span>;
}
