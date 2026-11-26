import { useCallback, useSyncExternalStore } from "react";
import type { MicroSeriesState } from "../api/generated/MicroSeriesState";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WatchMicroPage } from "../api/generated/WatchMicroPage";
import type { WatchMicroRow } from "../api/generated/WatchMicroRow";
import { ApiRequestError } from "../api/http";
import { fetchWatchMicro } from "../api/microSeries";
import { isIndexCode } from "../lib/symbol";

export interface WatchMicroEntry {
  readonly programNetMillionWon: number | undefined;
  readonly whaleNetMillionWon: number | undefined;
}

const EMPTY_MICRO: WatchMicroEntry = { programNetMillionWon: undefined, whaleNetMillionWon: undefined };
const POLL_MS = 10_000;
const CHUNK_SIZE = 200;

type FetchBatch = (symbols: readonly SymbolCode[], signal?: AbortSignal) => Promise<WatchMicroPage>;

function sameEntry(a: WatchMicroEntry | undefined, b: WatchMicroEntry): boolean {
  return a !== undefined && a.programNetMillionWon === b.programNetMillionWon && a.whaleNetMillionWon === b.whaleNetMillionWon;
}

function sameList(a: readonly SymbolCode[], b: readonly SymbolCode[]): boolean {
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

export class WatchMicroBook {
  private readonly leases = new Set<readonly SymbolCode[]>();
  private watched: readonly SymbolCode[] = [];
  private readonly rows = new Map<SymbolCode, WatchMicroEntry>();
  private readonly listeners = new Map<SymbolCode, Set<() => void>>();
  private readonly stateListeners = new Set<() => void>();
  private scheduled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private status: MicroSeriesState | "idle" = "idle";

  constructor(private readonly fetchBatch: FetchBatch) {}

  lease(symbols: readonly SymbolCode[]): () => void {
    this.leases.add(symbols);
    this.schedule();
    return () => {
      if (this.leases.delete(symbols)) this.schedule();
    };
  }

  get(code: SymbolCode): WatchMicroEntry {
    return this.rows.get(code) ?? EMPTY_MICRO;
  }

  state(): MicroSeriesState | "idle" {
    return this.status;
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

  subscribeState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private setStatus(next: MicroSeriesState | "idle"): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.stateListeners) listener();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.reconcile());
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller !== null) {
      this.controller.abort();
      this.controller = null;
    }
  }

  private reconcile(): void {
    this.scheduled = false;
    const seen = new Set<SymbolCode>();
    for (const list of this.leases) {
      for (const code of list) {
        if (!isIndexCode(code)) seen.add(code);
      }
    }
    const next = [...seen];
    if (sameList(next, this.watched)) return;
    const nextSet = new Set(next);
    this.watched = next;
    for (const code of [...this.rows.keys()]) {
      if (!nextSet.has(code)) {
        this.rows.delete(code);
        this.notify(code);
      }
    }
    this.stopPolling();
    if (next.length === 0) return;
    if (this.status === "disabled") return;
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.watched.length === 0) return;
    const symbols = this.watched;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const merged = new Map<SymbolCode, WatchMicroRow>();
      let disabled = false;
      for (let offset = 0; offset < symbols.length; offset += CHUNK_SIZE) {
        const chunk = symbols.slice(offset, offset + CHUNK_SIZE);
        const page = await this.fetchBatch(chunk, controller.signal);
        if (controller.signal.aborted) return;
        if (page.state === "disabled") {
          disabled = true;
          break;
        }
        for (const row of page.rows) merged.set(row.symbol, row);
      }
      if (controller.signal.aborted) return;
      if (disabled) {
        this.setStatus("disabled");
        return;
      }
      this.setStatus("ready");
      for (const code of symbols) {
        const row = merged.get(code);
        const entry: WatchMicroEntry = {
          programNetMillionWon: row?.programNetMillionWon,
          whaleNetMillionWon: row?.whaleNetMillionWon,
        };
        const current = this.rows.get(code);
        if (entry.programNetMillionWon === undefined && entry.whaleNetMillionWon === undefined) {
          if (current !== undefined) {
            this.rows.delete(code);
            this.notify(code);
          }
        } else if (!sameEntry(current, entry)) {
          this.rows.set(code, entry);
          this.notify(code);
        }
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.poll();
      }, POLL_MS);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiRequestError && error.code === "not_found") {
        this.setStatus("disabled");
        return;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.poll();
      }, POLL_MS);
    }
  }

  private notify(code: SymbolCode): void {
    const set = this.listeners.get(code);
    if (set) for (const listener of set) listener();
  }
}

export const watchMicroBook = new WatchMicroBook(fetchWatchMicro);

const noopSubscribe = () => () => {};

export function useWatchMicro(code: SymbolCode, enabled: boolean): WatchMicroEntry {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? watchMicroBook.subscribe(code, listener) : noopSubscribe()),
    [code, enabled],
  );
  const snapshot = useCallback(() => (enabled ? watchMicroBook.get(code) : EMPTY_MICRO), [code, enabled]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY_MICRO);
}

export function useWatchMicroState(): MicroSeriesState | "idle" {
  return useSyncExternalStore(
    (listener) => watchMicroBook.subscribeState(listener),
    () => watchMicroBook.state(),
    () => "idle",
  );
}
