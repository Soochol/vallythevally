const MINUTE_MS = 60_000;

export const FLOW_JITTER_MIN_MS = 2_000;
export const FLOW_JITTER_MAX_MS = 10_000;

export function nextFlowFetchDelayMs(now: number, random: () => number): number {
  const jitter = FLOW_JITTER_MIN_MS + random() * (FLOW_JITTER_MAX_MS - FLOW_JITTER_MIN_MS);
  const nextMinute = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
  return nextMinute + jitter - now;
}
