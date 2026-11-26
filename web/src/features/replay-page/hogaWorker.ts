import { decodeHogaSpan, type DecodedSpanPayload } from "./hogaDecode";

interface WorkerRequest {
  readonly id: number;
  readonly url: string;
}

interface WorkerSuccess {
  readonly id: number;
  readonly payload: DecodedSpanPayload;
}

interface WorkerFailure {
  readonly id: number;
  readonly error: string;
}

interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerSuccess | WorkerFailure, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScopeLike;

workerScope.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    const response = await fetch(data.url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const payload = decodeHogaSpan(buffer);
    const message: WorkerSuccess = { id: data.id, payload };
    workerScope.postMessage(message, [payload.buffer, payload.eventRecvMs, payload.eventKind, payload.eventRow]);
  } catch (error) {
    const message: WorkerFailure = { id: data.id, error: String(error instanceof Error ? error.message : error) };
    workerScope.postMessage(message);
  }
};
