import { ApiRequestError } from "../api/http";

/** 자료 하나(레이아웃, UiState, 관심종목)의 자동 저장 상태(frontend.md §3.7). */
export type SaveState =
  | { kind: "idle" }
  /** 바뀐 뒤 디바운스를 기다리는 중. */
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  /** 보내지 못했다. 5·15·60초 뒤 다시 보낸다. 세 번 다 실패하면 다시 시도 버튼만 남는다. */
  | { kind: "failed"; reason: "error"; message: string }
  /** 64KB를 넘는다. 같은 값을 다시 보내도 같으므로 다시 보내지 않는다. 다음 편집 때 다시 잰다. */
  | { kind: "failed"; reason: "too_large" };

export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface SaverOptions<T> {
  /** 마지막 편집 뒤 이만큼 기다렸다 보낸다. 0이면 같은 틱의 편집을 모아 곧바로 보낸다. */
  debounceMs: number;
  /** 지금 보낼 값. 보낼 때마다 최신 값을 읽는다. */
  read(): T;
  /** 보내기 전에 잰다(frontend.md §3.7a). 참이면 보내지 않는다. */
  tooLarge(value: T): boolean;
  /** 너무 클 때 화면이 스스로 줄일 수 있는 것을 줄인다. 줄였으면 참. 줄인 것도 편집이다. */
  shrink?(): boolean;
  send(json: string, opts: { keepalive: boolean }): Promise<unknown>;
  onState(state: SaveState): void;
  now?(): number;
}

export interface Saver {
  /** 편집이 있었다. */
  changed(): void;
  /** 다시 시도 버튼. 재시도 횟수를 처음부터 센다. */
  retry(): void;
  /** 탭이 숨을 때: 보내지 못한 편집이 있으면 기다리지 않고 keepalive로 보낸다. */
  flush(): void;
}

/**
 * 자료 하나를 PUT으로 통째 저장한다. 같은 자료의 요청은 한 번에 하나만 보낸다.
 * 보내는 동안 들어온 편집은 응답 뒤 디바운스를 거쳐 다음 요청에 실린다.
 */
export function createSaver<T>(o: SaverOptions<T>): Saver {
  const now = o.now ?? Date.now;
  let edits = 0;
  let savedEdits = 0;
  let inFlight = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      void run(false);
    }, ms);
  };

  async function run(keepalive: boolean) {
    if (inFlight || edits === savedEdits) return;
    cancel();
    inFlight = true;
    let value = o.read();
    if (o.tooLarge(value) && o.shrink?.()) value = o.read();
    const upTo = edits;
    if (o.tooLarge(value)) {
      inFlight = false;
      o.onState({ kind: "failed", reason: "too_large" });
      return;
    }
    o.onState({ kind: "saving" });
    try {
      await o.send(JSON.stringify(value), { keepalive });
    } catch (e) {
      inFlight = false;
      if (e instanceof ApiRequestError && e.code === "payload_too_large") {
        o.onState({ kind: "failed", reason: "too_large" });
        return;
      }
      o.onState({ kind: "failed", reason: "error", message: e instanceof Error ? e.message : String(e) });
      const delay = RETRY_DELAYS_MS[failures++];
      if (delay !== undefined) schedule(delay);
      return;
    }
    inFlight = false;
    savedEdits = upTo;
    failures = 0;
    if (edits > savedEdits) {
      o.onState({ kind: "pending" });
      schedule(o.debounceMs);
    } else {
      o.onState({ kind: "saved", at: now() });
    }
  }

  return {
    changed() {
      edits++;
      if (inFlight) return;
      failures = 0;
      o.onState({ kind: "pending" });
      schedule(o.debounceMs);
    },
    retry() {
      failures = 0;
      void run(false);
    },
    flush() {
      void run(true);
    },
  };
}
