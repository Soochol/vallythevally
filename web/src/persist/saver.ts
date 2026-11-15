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
  acceptStaleRevision?: boolean;
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
  changed(when?: "soon" | "now"): void;
  retry(): void;
  save(): Promise<void>;
  saveAndSuspend(): Promise<void>;
  resume(): void;
  advanceRevision(revision: number): void;
  stop(): Promise<void>;
  commitConditional(c: ConditionalCommit<T>): Promise<CommitOutcome>;
  /**
   * 탭이 숨을 때: 보내지 못한 편집이 있으면 기다리지 않고 keepalive로 보낸다.
   * 앞 요청이 아직 진행 중이어도 보낸다. 서버가 revision으로 순서를 지키므로 늦게 도착한 앞 요청이 이것을 덮지 못한다.
   */
  flush(): void;
}

export function createSaver<T extends object>(o: SaverOptions<T>): Saver<T> {
  const now = o.now ?? Date.now;
  let stopped = false;
  let suspended = false;
  let barrier = false;
  const requests = new Set<Promise<unknown>>();
  const request: SaverOptions<T>["send"] = (path, json, opts) => {
    const pending = o.send(path, json, opts);
    requests.add(pending);
    void pending.finally(() => requests.delete(pending)).catch(() => {});
    return pending;
  };
  let edits = 0;
  let urgent = false;
  const nextDelay = () => (urgent ? 0 : o.debounceMs);
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
    if (!stopped) o.onState(state);
  };

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    cancel();
    if (stopped || suspended || barrier) return;
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
    urgent = false;
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
      await request(req.path, req.body, { keepalive });
    } catch (e) {
      error = e;
    }
    inFlight--;
    if (inFlight === 0) { settled.forEach((resolve) => resolve()); settled.clear(); }
    if (stopped) return;
    const done = error === null || (o.acceptStaleRevision !== false && error instanceof ApiRequestError && error.code === "stale_revision");
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
      if (inFlight === 0 && edits > savedEdits && timer === null) schedule(nextDelay());
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
      if (inFlight === 0) schedule(nextDelay());
    } else {
      show({ kind: "saved", at: now() });
    }
  }

  function run() {
    if (stopped || suspended || barrier || inFlight > 0 || edits === savedEdits || edits === pause?.edits) return;
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
    if (stopped || suspended || barrier || edits === savedEdits || edits === pause?.edits) return;
    void send(true);
  }

  async function commitConditional(c: ConditionalCommit<T>): Promise<CommitOutcome> {
    if (stopped) return "superseded";
    flush();
    await settle();
    if (stopped) return "superseded";
    pauseCurrent();
    const previous = shown;
    const saving: SaveState = { kind: "saving" };
    try {
      for (let attempt = 0; attempt < CONDITIONAL_ATTEMPTS; attempt++) {
        if (stopped || !c.still()) return "superseded";
        const latest = await c.read();
        if (stopped || !c.still()) return "superseded";
        const value = c.next(latest.value, previous);
        if (!value) return "conflict";
        const saved = { ...value, revision: latest.revision + 1 };
        const req: Unsaved = { path: o.path(), revision: saved.revision, body: JSON.stringify(saved) };
        show(saving);
        o.unsaved?.write(req);
        try {
          await request(req.path, req.body, { keepalive: false });
          if (stopped) return "superseded";
        } catch (error) {
          if (stopped) return "superseded";
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

  async function save(suspend: boolean) {
    if (stopped || suspended || barrier) throw new Error("저장기를 사용할 수 없습니다");
    barrier = true;
    cancel();
    const waiting = inFlight > 0;
    try {
      await settle();
      if (stopped) throw new Error("저장기를 사용할 수 없습니다");
      if (waiting && shown.kind === "failed") throw new Error(shown.reason === "error" ? shown.message : "레이아웃이 저장 한도를 넘습니다");
      while (edits > savedEdits) {
        await send(false);
        if (stopped) throw new Error("저장기를 사용할 수 없습니다");
        if (shown.kind === "failed") throw new Error(shown.reason === "error" ? shown.message : "레이아웃이 저장 한도를 넘습니다");
      }
      suspended = suspend;
    } finally {
      barrier = false;
      if (!suspended && edits > savedEdits) schedule(nextDelay());
    }
  }

  return {
    changed(when = "soon") {
      if (stopped) return;
      edits++;
      urgent ||= when === "now";
      keep();
      if (suspended || barrier || inFlight > 0) return;
      failures = 0;
      show({ kind: "pending" });
      schedule(nextDelay());
    },
    retry() {
      if (stopped || suspended || barrier) return;
      if (pause?.kind === "retired") pause = null;
      failures = 0;
      run();
    },
    save: () => save(false),
    saveAndSuspend: () => save(true),
    resume() {
      if (stopped) return;
      suspended = false;
      run();
    },
    async stop() {
      stopped = true;
      cancel();
      await Promise.allSettled([...requests]);
    },
    advanceRevision,
    commitConditional,
    flush,
  };
}
