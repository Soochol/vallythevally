import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WhaleEvent } from "../api/generated/WhaleEvent";
import type { WhaleStockSummary } from "../api/generated/WhaleStockSummary";
import type { MarketSocket, WhaleSocketEvent } from "../api/socket";

const MAX_EVENTS = 2_000;

export interface WhaleBookSnapshot {
  readonly events: readonly WhaleEvent[];
  readonly summaries: ReadonlyMap<SymbolCode, WhaleStockSummary>;
  readonly watchedCount: number;
}

export class WhaleBook {
  private events: WhaleEvent[] = [];
  private summaries = new Map<SymbolCode, WhaleStockSummary>();
  private watchedCount = 0;
  private snapshot: WhaleBookSnapshot = { events: this.events, summaries: this.summaries, watchedCount: 0 };
  private readonly listeners = new Set<() => void>();
  private unsubSocket: (() => void) | null = null;

  constructor(private readonly socket: Pick<MarketSocket, "subscribeWhales">) {}

  getSnapshot(): WhaleBookSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.unsubSocket === null) {
      this.unsubSocket = this.socket.subscribeWhales((event) => this.onEvent(event));
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.unsubSocket !== null) {
        this.unsubSocket();
        this.unsubSocket = null;
      }
    };
  }

  clear(): void {
    this.events = [];
    this.summaries = new Map();
    this.publish();
  }

  private onEvent(event: WhaleSocketEvent): void {
    if (event.type === "whale_snapshot") {
      this.events = event.events.slice(0, MAX_EVENTS);
      const nextSummaries = new Map<SymbolCode, WhaleStockSummary>();
      for (const s of event.summaries) nextSummaries.set(s.symbol, s);
      this.summaries = nextSummaries;
      this.watchedCount = event.watchedCount;
      this.publish();
      return;
    }
    this.events = [event.event, ...this.events.slice(0, MAX_EVENTS - 1)];
    const nextSummaries = new Map(this.summaries);
    nextSummaries.set(event.summary.symbol, event.summary);
    this.summaries = nextSummaries;
    this.watchedCount = event.watchedCount;
    this.publish();
  }

  private publish(): void {
    this.snapshot = {
      events: this.events,
      summaries: this.summaries,
      watchedCount: this.watchedCount,
    };
    for (const listener of this.listeners) listener();
  }
}
