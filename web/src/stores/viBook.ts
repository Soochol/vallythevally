import type { SymbolCode } from "../api/generated/SymbolCode";
import type { ViState } from "../api/generated/ViState";
import type { Connection, MarketSocket, ViEvent } from "../api/socket";

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
  private readonly rows = new Map<SymbolCode, ViState>();
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private readonly knownListeners = new Set<() => void>();
  private known = false;

  constructor(socket: Pick<MarketSocket, "onVi" | "watch">) {
    socket.onVi((event) => this.onEvent(event));
    socket.watch((connection) => this.onConnection(connection));
  }

  get(code: SymbolCode): ViState | null {
    return this.rows.get(code) ?? null;
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
    if (this.rows.size === 0) return;
    const cleared = [...this.rows.keys()];
    this.rows.clear();
    for (const code of cleared) this.notify(code);
  }

  private onEvent(event: ViEvent): void {
    switch (event.type) {
      case "vi_update": {
        const next = event.state;
        if (next.market !== "krx") return;
        const prev = this.rows.get(next.symbol);
        if (prev !== undefined && sameViState(prev, next)) return;
        this.rows.set(next.symbol, next);
        this.notify(next.symbol);
        return;
      }
      case "vi_snapshot": {
        const incoming = new Set<SymbolCode>();
        const changed = new Set<SymbolCode>();
        for (const state of event.states) {
          if (state.market !== "krx") continue;
          incoming.add(state.symbol);
          const prev = this.rows.get(state.symbol);
          if (prev !== undefined && sameViState(prev, state)) continue;
          this.rows.set(state.symbol, state);
          changed.add(state.symbol);
        }
        for (const code of this.rows.keys()) {
          if (incoming.has(code)) continue;
          this.rows.delete(code);
          changed.add(code);
        }
        for (const code of changed) this.notify(code);
        this.setKnown(true);
        return;
      }
    }
  }

  private notify(code: SymbolCode): void {
    for (const listener of this.listeners.get(code) ?? []) listener();
  }
}
