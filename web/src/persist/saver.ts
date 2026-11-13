import { ApiRequestError } from "../api/http";

export type SaveState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "failed"; reason: "error"; message: string }
  | { kind: "failed"; reason: "too_large" };

export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface Unsaved {
  path: string;
  revision: number;
  body: string;
}

export interface SaverOptions<T extends object> {
  debounceMs: number;
  read(): T;
  tooLarge(value: T): boolean;
  shrink?(): boolean;
  path(): string;
  revision: number;
  send(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  unsaved?: { write(u: Unsaved): void; clear(upTo: number): void };
  onState(state: SaveState): void;
  now?(): number;
}

export type CommitOutcome = "committed" | "conflict" | "superseded";

export interface ConditionalCommit<T extends object> {
  read(): Promise<{ value: T; revision: number }>;
  next(latest: T, previous: SaveState): T | null;
  still(): boolean;
  accept(saved: T & { revision: number }): void;
}

const CONDITIONAL_ATTEMPTS = 3;

export interface Saver<T extends object> {
  changed(): void;
  retry(): void;
  commitConditional(c: ConditionalCommit<T>): Promise<CommitOutcome>;
  /**
   * 탭이 숨을 때: 보내지 못한 편집이 있으면 기다리지 않고 keepalive로 보낸다.
   * 앞 요청이 아직 진행 중이어도 보낸다. 서버가 revision으로 순서를 지키므로 늦게 도착한 앞 요청이 이것을 덮지 못한다.
   */
  flush(): void;
}

export function createSaver<T extends object>(o: SaverOptions<T>): Saver<T> {
  const now = o.now ?? Date.now;
  let edits = 0;
  let savedEdits = 0;
  let inFlight = 0;
  let failures = 0;
  let revision = o.revision;
  let newest = 0;
  let pause: { kind: "active" | "retired"; edits: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = new Set<() => void>();
  let shown: SaveState = { kind: "idle" };
  const show = (state: SaveState) => {
    shown = state;
    o.onState(state);
  };

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
      show({ kind: "failed", reason: "too_large" });
      return;
    }
    const req = body(value);
    o.unsaved?.write(req);
    newest = req.revision;
    inFlight++;
    show({ kind: "saving" });
    let error: unknown = null;
    try {
      await o.send(req.path, req.body, { keepalive });
    } catch (e) {
      error = e;
    }
    inFlight--;
    if (inFlight === 0) { settled.forEach((resolve) => resolve()); settled.clear(); }
    // stale_revision: 서버에 이것보다 새 편집(이 탭의 나중 요청, 또는 다른 탭)이 이미 있다. 이 본문은 할 일을 마쳤다.
    const done = error === null || (error instanceof ApiRequestError && error.code === "stale_revision");
    const tooLarge = error instanceof ApiRequestError && error.code === "payload_too_large";
    if (done || tooLarge) o.unsaved?.clear(req.revision);
    if (done) savedEdits = Math.max(savedEdits, upTo);
    if (inFlight === 0 && edits === savedEdits) {
      cancel();
      failures = 0;
      show({ kind: "saved", at: now() });
      return;
    }
    if (req.revision !== newest) {
      if (inFlight === 0 && edits > savedEdits && timer === null) schedule(o.debounceMs);
      return;
    }
    if (tooLarge) {
      show({ kind: "failed", reason: "too_large" });
      return;
    }
    if (!done) {
      show({ kind: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) });
      const delay = RETRY_DELAYS_MS[failures++];
      if (delay !== undefined) schedule(delay);
      return;
    }
    failures = 0;
    if (edits > savedEdits) {
      show({ kind: "pending" });
      if (inFlight === 0) schedule(o.debounceMs);
    } else {
      show({ kind: "saved", at: now() });
    }
  }

  function run() {
    if (inFlight > 0 || edits === savedEdits || edits === pause?.edits) return;
    void send(false);
  }

  const settle = () => inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => settled.add(resolve));
  const advanceRevision = (received: number) => { revision = Math.max(revision, received); };
  function acceptSaved(received: number) {
    advanceRevision(received);
    savedEdits = edits;
    cancel();
    failures = 0;
    o.unsaved?.clear(revision);
    show({ kind: "saved", at: now() });
  }
  function pauseCurrent() {
    cancel();
    pause = { kind: "active", edits };
  }
  function resume() {
    if (pause?.edits === edits) { pause = { kind: "retired", edits }; return; }
    pause = null;
    run();
  }
  function flush() {
    if (edits === savedEdits || edits === pause?.edits) return;
    void send(true);
  }

  async function commitConditional(c: ConditionalCommit<T>): Promise<CommitOutcome> {
    flush();
    await settle();
    pauseCurrent();
    const previous = shown;
    const saving: SaveState = { kind: "saving" };
    try {
      for (let attempt = 0; attempt < CONDITIONAL_ATTEMPTS; attempt++) {
        if (!c.still()) return "superseded";
        const latest = await c.read();
        if (!c.still()) return "superseded";
        const value = c.next(latest.value, previous);
        if (!value) return "conflict";
        const saved = { ...value, revision: latest.revision + 1 };
        const req: Unsaved = { path: o.path(), revision: saved.revision, body: JSON.stringify(saved) };
        show(saving);
        o.unsaved?.write(req);
        try {
          await o.send(req.path, req.body, { keepalive: false });
        } catch (error) {
          if (error instanceof ApiRequestError && error.code === "stale_revision") {
            o.unsaved?.clear(req.revision);
            continue;
          }
          throw error;
        }
        o.unsaved?.clear(req.revision);
        if (c.still()) {
          c.accept(saved);
          acceptSaved(saved.revision);
        } else advanceRevision(saved.revision);
        return "committed";
      }
      return "conflict";
    } finally {
      if (shown === saving) show(previous);
      resume();
    }
  }

  return {
    changed() {
      edits++;
      keep();
      if (inFlight > 0) return;
      failures = 0;
      show({ kind: "pending" });
      schedule(o.debounceMs);
    },
    retry() {
      if (pause?.kind === "retired") pause = null;
      failures = 0;
      run();
    },
    commitConditional,
    flush,
  };
}
