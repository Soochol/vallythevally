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

/** 서버가 받았다고 확인하지 않은 최신 본문. 탭이 닫혀도 남겨 다음 시작 때 되살린다(R2, `persist/unsaved.ts`). */
export interface Unsaved {
  path: string;
  revision: number;
  /** `revision`까지 담은, 보낼 JSON 그대로. */
  body: string;
}

export interface SaverOptions<T extends object> {
  /** 마지막 편집 뒤 이만큼 기다렸다 보낸다. 0이면 같은 틱의 편집을 모아 곧바로 보낸다. */
  debounceMs: number;
  /** 지금 보낼 값(`revision` 없이). 보낼 때마다 최신 값을 읽는다. */
  read(): T;
  /** 보내기 전에 잰다(frontend.md §3.7a). 참이면 보내지 않는다. */
  tooLarge(value: T): boolean;
  /** 너무 클 때 화면이 스스로 줄일 수 있는 것을 줄인다. 줄였으면 참. 줄인 것도 편집이다. */
  shrink?(): boolean;
  path(): string;
  /** 지금까지 쓴 가장 큰 revision(서버에 저장된 것, 되살린 미저장 본문). 보낼 revision은 언제나 이보다 크다. */
  revision: number;
  send(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  /** 미저장 본문을 둘 곳. 편집과 전송마다 최신 본문을 쓰고, 서버가 그 revision 이상을 가졌다고 확인되면 지운다. */
  unsaved?: { write(u: Unsaved): void; clear(upTo: number): void };
  onState(state: SaveState): void;
  now?(): number;
}

export interface Saver {
  /** 편집이 있었다. */
  changed(): void;
  /** 다시 시도 버튼. 재시도 횟수를 처음부터 센다. */
  retry(): void;
  /**
   * 탭이 숨을 때: 보내지 못한 편집이 있으면 기다리지 않고 keepalive로 보낸다.
   * 앞 요청이 아직 진행 중이어도 보낸다. 서버가 revision으로 순서를 지키므로 늦게 도착한 앞 요청이 이것을 덮지 못한다.
   */
  flush(): void;
}

/**
 * 자료 하나를 PUT으로 통째 저장한다. 본문마다 늘어나는 `revision`을 붙이고, 서버는 저장된 것보다 큰 것만 받는다.
 * 평소에는 같은 자료의 요청을 한 번에 하나만 보내고, 보내는 동안 들어온 편집은 응답 뒤 디바운스를 거쳐 다음 요청에 실린다.
 */
export function createSaver<T extends object>(o: SaverOptions<T>): Saver {
  const now = o.now ?? Date.now;
  let edits = 0;
  let savedEdits = 0;
  let inFlight = 0;
  let failures = 0;
  let revision = o.revision;
  /** 가장 나중에 보낸 요청의 revision. 그 요청의 결과만 상태를 바꾼다. */
  let newest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, ms);
  };
  const body = (value: T): Unsaved => {
    revision = Math.max(now(), revision + 1);
    return { path: o.path(), revision, body: JSON.stringify({ ...value, revision }) };
  };

  /** 편집을 곧바로 미저장 본문으로 남긴다. 디바운스 중에 탭이 죽어도 다음 시작 때 되살린다. */
  function keep() {
    if (!o.unsaved) return;
    const value = o.read();
    if (!o.tooLarge(value)) o.unsaved.write(body(value));
  }

  async function send(keepalive: boolean) {
    cancel();
    let value = o.read();
    if (o.tooLarge(value) && o.shrink?.()) value = o.read();
    const upTo = edits;
    if (o.tooLarge(value)) {
      o.onState({ kind: "failed", reason: "too_large" });
      return;
    }
    const req = body(value);
    o.unsaved?.write(req);
    newest = req.revision;
    inFlight++;
    o.onState({ kind: "saving" });
    let error: unknown = null;
    try {
      await o.send(req.path, req.body, { keepalive });
    } catch (e) {
      error = e;
    }
    inFlight--;
    // stale_revision: 서버에 이것보다 새 편집(이 탭의 나중 요청, 또는 다른 탭)이 이미 있다. 이 본문은 할 일을 마쳤다.
    const done = error === null || (error instanceof ApiRequestError && error.code === "stale_revision");
    const tooLarge = error instanceof ApiRequestError && error.code === "payload_too_large";
    if (done || tooLarge) o.unsaved?.clear(req.revision);
    if (done) savedEdits = Math.max(savedEdits, upTo);
    if (inFlight === 0 && edits === savedEdits) {
      // 이 요청이든 앞 요청이든, 모든 편집이 저장됐다. 나중 요청의 실패로 잡아 둔 재시도도 필요 없다.
      cancel();
      failures = 0;
      o.onState({ kind: "saved", at: now() });
      return;
    }
    if (req.revision !== newest) {
      // 더 나중 요청이 상태를 맡는다. 그 요청이 먼저 끝나 기다리던 편집이 남았으면 이제 보낸다.
      if (inFlight === 0 && edits > savedEdits && timer === null) schedule(o.debounceMs);
      return;
    }
    if (tooLarge) {
      o.onState({ kind: "failed", reason: "too_large" });
      return;
    }
    if (!done) {
      o.onState({ kind: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) });
      const delay = RETRY_DELAYS_MS[failures++];
      if (delay !== undefined) schedule(delay);
      return;
    }
    failures = 0;
    if (edits > savedEdits) {
      o.onState({ kind: "pending" });
      if (inFlight === 0) schedule(o.debounceMs);
    } else {
      o.onState({ kind: "saved", at: now() });
    }
  }

  function run() {
    if (inFlight > 0 || edits === savedEdits) return;
    void send(false);
  }

  return {
    changed() {
      edits++;
      keep();
      if (inFlight > 0) return;
      failures = 0;
      o.onState({ kind: "pending" });
      schedule(o.debounceMs);
    },
    retry() {
      failures = 0;
      run();
    },
    flush() {
      if (edits === savedEdits) return;
      void send(true);
    },
  };
}
