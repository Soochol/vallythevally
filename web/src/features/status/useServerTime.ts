import { useEffect, useState } from "react";
import { serverNow, useServerClock } from "../../stores/serverClock";

export function useServerTime(): number {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [now, setNow] = useState(() => serverNow(origin) / 1000);
  useEffect(() => {
    const tick = () => setNow(serverNow(origin) / 1000);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [origin]);
  return now;
}
