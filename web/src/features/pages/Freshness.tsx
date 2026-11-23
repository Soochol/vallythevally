import { useState, type ReactNode } from "react";
import { isMarketOpen, formatKstClockSeconds } from "../../chart/time";
import { useServerTime } from "../status/useServerTime";

export const STALE_AFTER_SECONDS = 60;

export interface FreshnessClock {
  receivedAt?: number | null;
  live?: boolean;
  failed?: boolean;
}

function isStale(clock: FreshnessClock | undefined, now: number, since: number): boolean {
  if (clock === undefined || clock.receivedAt === undefined) return false;
  const live = clock.live ?? isMarketOpen(now);
  if (!live) return false;
  return now - (clock.receivedAt ?? since) > STALE_AFTER_SECONDS;
}

export function Freshness({ clock, children }: { clock?: FreshnessClock; children?: ReactNode }) {
  const now = useServerTime();
  const [since] = useState(now);
  if (clock === undefined && !children) return null;
  const stale = isStale(clock, now, since);
  const tone = stale ? "stale" : clock?.failed ? "failed" : "ok";
  const last = clock?.receivedAt;
  return (
    <div className="page-frame-freshness" role="status" aria-label="자료 신선도" data-tone={tone}>
      <span className="freshness-dot" aria-hidden="true" />
      {stale && <span className="freshness-missed">받지 못함 · 마지막 {last == null ? "—" : formatKstClockSeconds(last)}</span>}
      {children}
    </div>
  );
}
