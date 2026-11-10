import type { FromWorker, ToWorker } from "./protocol";

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** 컨트롤러 하나가 쓰는 워커 연결. cell은 컨트롤러 인스턴스 번호다(칸 번호가 아니다). */
export interface IndicatorPort {
  readonly cell: number;
  post(msg: ToWorker, transfer?: Transferable[]): void;
  close(): void;
}

export interface PortListener {
  message(m: Exclude<FromWorker, { type: "fatal" }>): void;
  /** wasm init 실패, 워커 오류. 그 뒤로는 계산하지 않는다. */
  broken(message: string): void;
}

export type OpenPort = (listener: PortListener) => IndicatorPort;

/** 탭에 워커 하나를 두고 칸마다 응답을 나눠 준다(frontend.md §5.6). */
export function createHub(makeWorker: () => WorkerLike): OpenPort {
  let worker: WorkerLike | null = null;
  let brokenWith: string | null = null;
  let nextCell = 0;
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
      listeners.get(m.cell)?.message(m);
    };
    worker.onerror = (e) => breakAll(e.message || "지표 워커 오류");
    return worker;
  };

  return (listener) => {
    const cell = ++nextCell;
    ensure();
    listeners.set(cell, listener);
    if (brokenWith !== null) {
      const message = brokenWith;
      queueMicrotask(() => listeners.get(cell)?.broken(message));
    }
    return {
      cell,
      post: (msg, transfer = []) => {
        if (brokenWith === null) ensure()?.postMessage(msg, transfer);
      },
      close: () => {
        if (!listeners.delete(cell)) return;
        if (brokenWith === null && worker) worker.postMessage({ type: "drop", cell, ids: "all" }, []);
      },
    };
  };
}

export const openIndicatorPort: OpenPort = createHub(
  () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "indicators" }) as unknown as WorkerLike,
);
