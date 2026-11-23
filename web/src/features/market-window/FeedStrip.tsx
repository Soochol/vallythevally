import { useRef } from "react";
import { formatClock } from "./format";

export function useFeedDownSince(connected: boolean): number | null {
  const since = useRef<number | null>(null);
  if (connected) since.current = null;
  else if (since.current === null) since.current = Date.now();
  return since.current;
}

export function FeedStrip({ since }: { since: number | null }) {
  return (
    <div className="mw-feed-strip" role="status" data-testid="feed-down">
      실시간 끊김{since !== null && ` · ${formatClock(Math.floor(since / 1000))}부터`} · 다시 잇는 중
    </div>
  );
}
