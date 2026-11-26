import { decodeHogaSpan, type DecodedSpanPayload, openHogaSpan, type OpenedHogaSpan } from "./hogaDecode";

const DEFAULT_CACHE_LIMIT = 24;

export type SpanBufferFetcher = (url: string) => Promise<ArrayBuffer>;

interface WorkerMessage {
  readonly id: number;
  readonly payload?: DecodedSpanPayload;
  readonly error?: string;
}

export class HogaSpanLoader {
  private readonly limit: number;
  private readonly cache = new Map<string, OpenedHogaSpan>();
  private readonly failed = new Map<string, string>();
  private readonly inFlight = new Map<string, number>();
  private readonly pendingById = new Map<number, string>();
  private protectedKeys = new Set<string>();
  private worker: Worker | null = null;
  private readonly fetcher: SpanBufferFetcher | null;
  private nextId = 1;
  private disposed = false;
  onUpdate: (key: string, span: OpenedHogaSpan | null) => void = () => {};

  constructor(options?: { readonly limit?: number; readonly fetcher?: SpanBufferFetcher }) {
    this.limit = options?.limit ?? DEFAULT_CACHE_LIMIT;
    this.fetcher = options?.fetcher ?? null;
    if (this.fetcher === null && typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(new URL("./hogaWorker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
          this.handleWorkerMessage(data);
        };
      } catch {
        this.worker = null;
      }
    }
  }

  setProtected(keys: Iterable<string>): void {
    this.protectedKeys = new Set(keys);
  }

  get(key: string): OpenedHogaSpan | null {
    const span = this.cache.get(key);
    if (!span) return null;
    this.cache.delete(key);
    this.cache.set(key, span);
    return span;
  }

  peek(key: string): OpenedHogaSpan | null {
    return this.cache.get(key) ?? null;
  }

  hasFailed(key: string): boolean {
    return this.failed.has(key);
  }

  isPending(key: string): boolean {
    return this.inFlight.has(key);
  }

  cachedKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  request(key: string, url: string): void {
    if (this.disposed || this.cache.has(key) || this.failed.has(key) || this.inFlight.has(key)) return;
    const id = this.nextId++;
    this.inFlight.set(key, id);
    this.pendingById.set(id, key);
    if (this.worker !== null) {
      this.worker.postMessage({ id, url });
      return;
    }
    void this.fetchInline(id, key, url);
  }

  clear(): void {
    this.cache.clear();
    this.failed.clear();
    this.inFlight.clear();
    this.pendingById.clear();
    this.protectedKeys.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.clear();
  }

  private async fetchInline(id: number, key: string, url: string): Promise<void> {
    try {
      const buffer = this.fetcher
        ? await this.fetcher(url)
        : await (async () => {
            const response = await fetch(url, { credentials: "same-origin" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.arrayBuffer();
          })();
      if (this.disposed || this.pendingById.get(id) !== key) return;
      const payload = decodeHogaSpan(buffer);
      this.finishSuccess(id, payload);
    } catch (error) {
      if (this.disposed || this.pendingById.get(id) !== key) return;
      this.finishError(id, String(error instanceof Error ? error.message : error));
    }
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    if (this.disposed) return;
    if (message.payload) {
      this.finishSuccess(message.id, message.payload);
    } else {
      this.finishError(message.id, message.error ?? "구간 파일을 읽지 못했습니다");
    }
  }

  private finishSuccess(id: number, payload: DecodedSpanPayload): void {
    const key = this.pendingById.get(id);
    if (!key) return;
    this.pendingById.delete(id);
    this.inFlight.delete(key);
    const span = openHogaSpan(payload);
    this.cache.set(key, span);
    this.evict();
    this.onUpdate(key, span);
  }

  private finishError(id: number, error: string): void {
    const key = this.pendingById.get(id);
    if (!key) return;
    this.pendingById.delete(id);
    this.inFlight.delete(key);
    this.failed.set(key, error);
    this.onUpdate(key, null);
  }

  private evict(): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.limit) break;
      if (!this.protectedKeys.has(key)) this.cache.delete(key);
    }
  }
}
