import type { SymbolCode } from "../api/generated/SymbolCode";
import type { ViMarket } from "../api/generated/ViMarket";
import type { ViState } from "../api/generated/ViState";
import type { Connection, MarketSocket, ViEvent } from "../api/socket";

const MARKETS: readonly ViMarket[] = ["krx", "nxt"];

function sameViState(a: ViState, b: ViState): boolean {
  return (
    a.symbol === b.symbol &&
    a.market === b.market &&
    a.active === b.active &&
    a.direction === b.direction &&
    a.triggerPrice === b.triggerPrice &&
    a.base === b.base &&
    a.triggeredAt === b.triggeredAt &&
    a.releasedAt === b.releasedAt
  );
}

export class ViBook {
  private readonly rows: Record<ViMarket, Map<SymbolCode, ViState>> = {
    krx: new Map(),
    nxt: new Map(),
  };
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private readonly knownListeners = new Set<() => void>();
  private known = false;

  constructor(socket: Pick<MarketSocket, "onVi" | "watch">) {
    socket.onVi((event) => this.onEvent(event));
    socket.watch((connection) => this.onConnection(connection));
  }

  get(code: SymbolCode, market: ViMarket): ViState | null {
    return this.rows[market].get(code) ?? null;
  }

  isKnown(): boolean {
    return this.known;
  }

  subscribe(code: SymbolCode, listener: () => void): () => void {
    let set = this.listeners.get(code);
    if (!set) this.listeners.set(code, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(code) === set) this.listeners.delete(code);
    };
  }

  subscribeKnown(listener: () => void): () => void {
    this.knownListeners.add(listener);
    return () => {
      this.knownListeners.delete(listener);
    };
  }

  private setKnown(next: boolean): void {
    if (this.known === next) return;
    this.known = next;
    for (const listener of this.knownListeners) listener();
  }

  private onConnection(connection: Connection): void {
    if (connection.socket === "open") return;
    this.setKnown(false);
    const cleared = new Set<SymbolCode>();
    for (const market of MARKETS) {
      const bucket = this.rows[market];
      for (const code of bucket.keys()) cleared.add(code);
      bucket.clear();
    }
    for (const code of cleared) this.notify(code);
  }

  private onEvent(event: ViEvent): void {
    switch (event.type) {
      case "vi_update": {
        const next = event.state;
        const bucket = this.rows[next.market];
        const prev = bucket.get(next.symbol);
        if (prev !== undefined && sameViState(prev, next)) return;
        bucket.set(next.symbol, next);
        this.notify(next.symbol);
        return;
      }
      case "vi_snapshot": {
        const incoming: Record<ViMarket, Set<SymbolCode>> = {
          krx: new Set(),
          nxt: new Set(),
        };
        const changed = new Set<SymbolCode>();
        for (const state of event.states) {
          const bucket = this.rows[state.market];
          incoming[state.market].add(state.symbol);
          const prev = bucket.get(state.symbol);
          if (prev !== undefined && sameViState(prev, state)) continue;
          bucket.set(state.symbol, state);
          changed.add(state.symbol);
        }
        for (const market of MARKETS) {
          const bucket = this.rows[market];
          for (const code of bucket.keys()) {
            if (incoming[market].has(code)) continue;
            bucket.delete(code);
            changed.add(code);
          }
        }
        for (const code of changed) this.notify(code);
        this.setKnown(true);
        return;
      }
      case "vi_expected_snapshot":
        return;
    }
  }

  private notify(code: SymbolCode): void {
    for (const listener of this.listeners.get(code) ?? []) listener();
  }
}
