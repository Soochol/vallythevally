import { useEffect, useState } from "react";
import { serverNow, useServerClock } from "../../stores/serverClock";

const MINUTE_MS = 60_000;

export type ServerTimeTick = "second" | "minute";

export function useServerTime(tick: ServerTimeTick = "second"): number {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [now, setNow] = useState(() => serverNow(origin) / 1000);
  useEffect(() => {
    const read = () => setNow(serverNow(origin) / 1000);
    read();
    if (tick === "second") {
      const timer = setInterval(read, 1000);
      return () => clearInterval(timer);
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        read();
        schedule();
      }, MINUTE_MS - (serverNow(origin) % MINUTE_MS) + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [origin, tick]);
  return now;
}
