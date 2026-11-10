import type { FromWorker, ToWorker } from "./protocol";

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export interface IndicatorPort {
  readonly chart: number;
  post(msg: ToWorker, transfer?: Transferable[]): void;
  close(): void;
}

export interface PortListener {
  message(m: Exclude<FromWorker, { type: "fatal" }>): void;
  broken(message: string): void;
}

export type OpenPort = (listener: PortListener) => IndicatorPort;

export function createHub(makeWorker: () => WorkerLike): OpenPort {
  let worker: WorkerLike | null = null;
  let brokenWith: string | null = null;
  let nextChart = 0;
  const listeners = new Map<number, PortListener>();

  const breakAll = (message: string) => {
    if (brokenWith !== null) return;
    brokenWith = message;
    for (const l of listeners.values()) l.broken(message);
  };

  const ensure = (): WorkerLike | null => {
    if (worker || brokenWith !== null) return worker;
    try {
      worker = makeWorker();
    } catch (e) {
      breakAll(e instanceof Error ? e.message : String(e));
      return null;
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "fatal") return breakAll(m.message);
      listeners.get(m.chart)?.message(m);
    };
    worker.onerror = (e) => breakAll(e.message || "지표 워커 오류");
    return worker;
  };

  return (listener) => {
    const chart = ++nextChart;
    ensure();
    listeners.set(chart, listener);
    if (brokenWith !== null) {
      const message = brokenWith;
      queueMicrotask(() => listeners.get(chart)?.broken(message));
    }
    return {
      chart,
      post: (msg, transfer = []) => {
        if (brokenWith === null) ensure()?.postMessage(msg, transfer);
      },
      close: () => {
        if (!listeners.delete(chart)) return;
        if (brokenWith === null && worker) worker.postMessage({ type: "drop", chart, ids: "all" }, []);
      },
    };
  };
}

export const openIndicatorPort: OpenPort = createHub(
  () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "indicators" }) as unknown as WorkerLike,
);
