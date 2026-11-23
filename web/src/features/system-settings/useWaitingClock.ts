import { useEffect, useReducer } from "react";
import { serverNow, useServerClock } from "../../stores/serverClock";

export function useWaitingClock(retryAts: readonly (number | null | undefined)[]): number {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const now = serverNow(origin) / 1000;
  const waiting = retryAts.some((at) => at != null && at > now);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(redraw, 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  return now;
}
