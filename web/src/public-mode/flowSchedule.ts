const MINUTE_MS = 60_000;

export const FLOW_JITTER_MIN_MS = 2_000;
export const FLOW_JITTER_MAX_MS = 10_000;

export function nextFlowFetchDelayMs(now: number, random: () => number): number {
  const jitter = FLOW_JITTER_MIN_MS + random() * (FLOW_JITTER_MAX_MS - FLOW_JITTER_MIN_MS);
  const nextMinute = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
  return nextMinute + jitter - now;
}

interface SettledQuery {
  state: { dataUpdatedAt: number; errorUpdatedAt: number };
}

export class FlowRefresh {
  private readonly drawn = new WeakMap<object, { settledAt: number; delayMs: number }>();

  constructor(
    private readonly now: () => number,
    private readonly random: () => number,
  ) {}

  intervalMs(query: SettledQuery): number | false {
    const settledAt = Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt);
    if (settledAt === 0) return false;
    const known = this.drawn.get(query);
    if (known?.settledAt === settledAt) return known.delayMs;
    const delayMs = nextFlowFetchDelayMs(this.now(), this.random);
    this.drawn.set(query, { settledAt, delayMs });
    return delayMs;
  }
}
