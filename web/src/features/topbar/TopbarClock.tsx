import { useEffect, useState } from "react";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatKstClockSeconds, isMarketOpen } from "../../chart/time";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { secondOfDay } from "../trades/tape";

export type MarketSessionLabel = "장전" | "장전동시" | "정규장" | "장후동시" | "NXT 애프터" | "장마감";

const clockSec = (hour: number, minute: number): number => hour * 3600 + minute * 60;

export function marketSessionLabel(unixSeconds: UnixSeconds): MarketSessionLabel {
  if (!isMarketOpen(unixSeconds)) return "장마감";
  const second = secondOfDay(unixSeconds);
  if (second < clockSec(8, 50)) return "장전";
  if (second < clockSec(9, 0)) return "장전동시";
  if (second < clockSec(15, 20)) return "정규장";
  if (second < clockSec(15, 30)) return "장후동시";
  return "NXT 애프터";
}

function nextSecondDelayMs(nowMs: number): number {
  const remainder = ((Math.floor(nowMs) % 1000) + 1000) % 1000;
  return Math.max(16, 1000 - remainder);
}

export function TopbarClock() {
  const origin = useServerClock((s) => s.serverTimeOrigin);
  const [nowSec, setNowSec] = useState<UnixSeconds>(() => Math.floor(serverNow(origin) / 1000));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const syncAndSchedule = () => {
      const nowMs = serverNow(origin);
      setNowSec(Math.floor(nowMs / 1000));
      timer = setTimeout(syncAndSchedule, nextSecondDelayMs(nowMs));
    };
    syncAndSchedule();
    return () => clearTimeout(timer);
  }, [origin]);

  const clockText = formatKstClockSeconds(nowSec);
  const session = marketSessionLabel(nowSec);

  return (
    <time
      className="topbar-clock"
      dateTime={new Date(nowSec * 1000).toISOString()}
      aria-label={`한국 시각 ${clockText} ${session}`}
      title={`KST ${clockText} · ${session}`}
      data-testid="topbar-clock"
      data-session={session}
    >
      <span className="topbar-clock-time">{clockText}</span>
      <span className="topbar-clock-session">{session}</span>
    </time>
  );
}
