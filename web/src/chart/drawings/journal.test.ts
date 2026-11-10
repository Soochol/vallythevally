import { describe, expect, test, vi } from "vitest";
import { compareIntent, COMPLETION_PREFIX, completionKey, DrawingJournal, parseJournalRecord, stageKey, STAGING_PREFIX } from "./journal";
import { recordKey, type Intent } from "./outbox";
import type { DrawingBody } from "./types";

const body = (id = "a", revision = 0): DrawingBody => ({ id, symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision });
const input = (id = "a") => ({ id, symbol: "005930", want: { kind: "put", body: body(id) } as const, observedRevision: 0 });
const deletion = (id = "a") => ({ ...input(id), want: { kind: "delete" } as const });
function fixture(initial: Record<string, string> = {}) {
  const values = { ...initial };
  const hooks = { set: (_key: string, _value: string) => {}, remove: (_key: string) => {}, get: (_key: string) => {} };
  const storage = new Proxy(new class implements Storage {
    get length() { return Object.keys(values).length; }
    getItem(key: string) { hooks.get(key); return values[key] ?? null; }
    setItem(key: string, value: string) { hooks.set(key, value); values[key] = value; }
    removeItem(key: string) { hooks.remove(key); delete values[key]; }
    clear() { for (const key of Object.keys(values)) delete values[key]; }
    key(index: number) { return Object.keys(values)[index] ?? null; }
  }, {
    ownKeys: () => Object.keys(values),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && key in values ? { configurable: true, enumerable: true, value: values[key] } : undefined,
  });
  const queues = new Map<string, Promise<unknown>>();
  const locks = { request: async <T>(name: string, options: LockOptions | LockGrantedCallback<T>, callback?: LockGrantedCallback<T>): Promise<Awaited<T>> => {
    const work = typeof options === "function" ? options : callback;
    if (!work) throw new Error("missing lock callback");
    const previous = queues.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => work({ name, mode: "exclusive" }));
    queues.set(name, next);
    return await next;
  } };
  const journal = () => new DrawingJournal(storage, locks);
  return { values, storage, hooks, journal };
}
function hideStage(values: Record<string, string>, intent: Intent) {
  const raw = values[stageKey(intent.uuid)];
  if (!raw) throw new Error("missing stage");
  delete values[stageKey(intent.uuid)];
  return () => { values[stageKey(intent.uuid)] = raw; };
}
const pendingKeys = (values: Record<string, string>) => Object.keys(values).filter((key) => !key.startsWith(COMPLETION_PREFIX));
function completion(values: Record<string, string>, id = "a"): unknown {
  const raw = values[completionKey(id)];
  if (!raw) throw new Error("missing completion");
  return JSON.parse(raw);
}

describe("durable drawing completion", () => {
  test("synchronously stores the complete immutable v2 PUT before returning", () => {
    const f = fixture(); const journal = f.journal();
    const intent = journal.stage(input(), () => 100);
    expect(intent.v).toBe(2);
    expect(Object.keys(f.values)).toEqual([stageKey(intent.uuid)]);
    expect(parseJournalRecord(JSON.parse(f.values[stageKey(intent.uuid)]!))).toEqual(intent);
    expect(intent.want.kind === "put" && intent.want.body.revision).toBe(100);
    expect(journal.stage(input(), () => 1).order).toBe(101);
    expect(intent.lastRevision).toBe(100);
  });

  test("a delayed first full publication cannot revive a completed newer DELETE", async () => {
    const f = fixture(); const producer = f.journal(); const newer = f.journal();
    const old = producer.stage(input(), () => 100); const publish = hideStage(f.values, old);
    const terminal = newer.stage(deletion(), () => 200);
    await newer.admit(terminal); await newer.complete(terminal);
    expect(pendingKeys(f.values)).toEqual([]);
    publish();
    expect(f.journal().snapshot().intents).toEqual([]);
    expect(await producer.admit(old)).toBe(false);
    expect(producer.isSendable(old)).toBe(false);
    const launch = vi.fn(() => true);
    expect(await producer.launch(old, launch)).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(await f.journal().recover("a")).toBeNull();
    expect(pendingKeys(f.values)).toEqual([]);
    expect(completion(f.values)).toMatchObject({ order: 200, uuid: terminal.uuid });
  });

  test("new same-id edits use retained order and revision while unrelated old edits remain valid", async () => {
    const f = fixture(); const producer = f.journal();
    const unrelated = producer.stage(input("unrelated"), () => 10); const publish = hideStage(f.values, unrelated);
    const terminal = f.journal().stage(deletion(), () => 200);
    await f.journal().admit(terminal); await f.journal().complete(terminal);
    publish();
    expect(await producer.admit(unrelated)).toBe(true);
    const fresh = f.journal().stage(input(), () => 1);
    expect(fresh.order).toBe(201);
    expect(unrelated.order).toBe(10);
    expect(unrelated.lastRevision).toBe(10);
  });

  test("newer same-id work and unrelated stages survive older completion", async () => {
    const f = fixture(); const journal = f.journal();
    const old = journal.stage(input(), () => 100); await journal.admit(old);
    const latest = journal.stage(input(), () => 200); await journal.admit(latest);
    const unrelated = journal.stage(input("b"), () => 1);
    await journal.complete(old); await journal.complete(old);
    expect(await f.journal().recover("a")).toEqual(latest);
    expect(journal.isSendable(latest)).toBe(true);
    expect(await f.journal().admit(unrelated)).toBe(true);
    expect(completion(f.values)).toMatchObject({ order: 100, uuid: old.uuid });
  });

  test("quota failure while retaining completion deletes nothing and preserves recovery work", async () => {
    const f = fixture(); const journal = f.journal();
    const old = journal.stage(input(), () => 100);
    const terminal = journal.stage(deletion(), () => 200); await journal.admit(terminal);
    const before = { ...f.values }; const removes = vi.fn();
    f.hooks.remove = removes;
    f.hooks.set = (key) => { if (key === completionKey("a")) throw new Error("quota"); };
    await expect(journal.complete(terminal)).rejects.toThrow("quota");
    expect(removes).not.toHaveBeenCalled();
    expect(f.values).toEqual(before);
    expect(await f.journal().recover("a")).toEqual(terminal);
    expect(f.values[stageKey(old.uuid)]).toBeDefined();
    f.hooks.set = () => {};
    await journal.complete(terminal);
    expect(pendingKeys(f.values)).toEqual([]);
  });

  test.each(["older", "terminal", "shared"])("retained completion suppresses all retry and reload paths after %s removal fails", async (failure) => {
    const f = fixture(); const journal = f.journal();
    const old = journal.stage(input(), () => 100);
    const terminal = journal.stage(deletion(), () => 200); await journal.admit(terminal);
    const failedKey = failure === "older" ? stageKey(old.uuid) : failure === "terminal" ? stageKey(terminal.uuid) : recordKey("a");
    f.hooks.remove = (key) => { if (key === failedKey) throw new Error("remove failed"); };
    await expect(journal.complete(terminal)).rejects.toThrow("remove failed");
    expect(completion(f.values)).toMatchObject({ order: 200, uuid: terminal.uuid });
    const reloaded = f.journal();
    expect(reloaded.snapshot().intents).toEqual([]);
    expect(reloaded.isSendable(old)).toBe(false);
    expect(reloaded.isSendable(terminal)).toBe(false);
    const send = vi.fn(() => true);
    expect(await reloaded.launch(old, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    f.hooks.remove = () => {};
    expect(await reloaded.recover("a")).toBeNull();
    expect(await journal.admit(old)).toBe(false);
    await journal.complete(terminal);
    expect(pendingKeys(f.values)).toEqual([]);
  });

  test("equal orders use UUID while revision maximum advances independently of the winning tuple", async () => {
    const f = fixture(); const journal = f.journal();
    const low: Intent = { v: 2, id: "a", symbol: "005930", uuid: "a", order: 100, want: { kind: "put", reserved: true, body: body("a", 900) }, lastRevision: 900 };
    const high: Intent = { ...low, uuid: "z", want: { kind: "delete" }, lastRevision: 10 };
    f.values[stageKey(high.uuid)] = JSON.stringify(high);
    await journal.complete(high);
    f.values[stageKey(low.uuid)] = JSON.stringify(low);
    await journal.complete(low);
    expect(completion(f.values)).toEqual({ v: 1, id: "a", order: 100, uuid: "z", lastRevision: 900 });
    const next = f.journal().stage(input(), () => 1);
    expect(next.order).toBe(101);
    expect(next.lastRevision).toBe(901);
    expect(compareIntent(low, high)).toBeLessThan(0);
    expect(await journal.admit(low)).toBe(false);
  });

  test("launch starts synchronous work under the lock and releases before its HTTP response", async () => {
    const f = fixture(); const journal = f.journal();
    const intent = journal.stage(input(), () => 100); await journal.admit(intent);
    const order: string[] = [];
    let finish = () => {};
    const response = new Promise<void>((resolve) => { finish = resolve; });
    expect(await journal.launch(intent, () => { order.push("native fetch"); void response.then(() => order.push("response")); return true; })).toBe(true);
    const next = journal.stage(deletion(), () => 200); await journal.admit(next);
    order.push("next admission");
    expect(order).toEqual(["native fetch", "next admission"]);
    finish(); await response;
    expect(order).toEqual(["native fetch", "next admission", "response"]);
  });
});

describe("drawing journal boundaries and migration", () => {
  test("v2 shared-only leftovers never recreate a retired stage", async () => {
    const old: Intent = { v: 2, id: "a", symbol: "005930", uuid: "retired-v2", order: 42, want: { kind: "delete" }, lastRevision: 41 };
    const f = fixture({ [recordKey("a")]: JSON.stringify(old) }); const journal = f.journal();
    expect(journal.snapshot().intents).toEqual([]);
    expect(await journal.admit(old)).toBe(false);
    expect(await journal.recover("a")).toBeNull();
    expect(pendingKeys(f.values)).toEqual([]);
    expect(f.values[stageKey(old.uuid)]).toBeUndefined();
  });

  test.each([{ revision: 0, reserved: true }, { revision: 42, reserved: true }, { revision: 731, reserved: false }])("v1 PUT retains fixed revision $revision during locked migration even when newer work wins", async ({ revision, reserved }) => {
    const legacy = { v: 1, id: "a", symbol: "005930", want: { kind: "put", body: body("a", revision), ...(reserved ? { reserved: true } : {}) }, lastRevision: revision };
    const f = fixture({ [recordKey("a")]: JSON.stringify(legacy) }); const journal = f.journal();
    const newer = journal.stage(deletion(), () => 1000);
    expect(await journal.admit(newer)).toBe(true);
    const migrated = journal.snapshot().intents.find((intent) => intent.uuid !== newer.uuid);
    expect(migrated?.want.kind === "put" && migrated.want.body.revision).toBe(revision);
    expect(await journal.recover("a")).toEqual(newer);
    await journal.complete(newer);
    expect(pendingKeys(f.values)).toEqual([]);
  });

  test("unreserved zero revision migrates once and reload keeps its exact identity", async () => {
    const f = fixture({ [recordKey("a")]: JSON.stringify({ v: 1, id: "a", symbol: "005930", want: { kind: "put", body: body() }, lastRevision: 0 }) });
    const first = await f.journal().recover("a");
    expect(first?.lastRevision).toBeGreaterThan(0);
    expect(await f.journal().recover("a")).toEqual(first);
  });

  test("a partial v1 migration retains its reserved UUID and revision across reload", async () => {
    const f = fixture({ [recordKey("a")]: JSON.stringify({ v: 1, id: "a", symbol: "005930", want: { kind: "put", body: body() }, lastRevision: 0 }) });
    f.hooks.remove = (key) => { if (key === recordKey("a")) throw new Error("legacy cleanup failed"); };
    await expect(f.journal().recover("a")).rejects.toThrow("legacy cleanup failed");
    const staged = f.journal().snapshot().intents;
    expect(staged).toHaveLength(1);
    f.hooks.remove = () => {};
    expect(await f.journal().recover("a")).toEqual(staged[0]);
    expect(Object.keys(f.values).filter((key) => key.startsWith(STAGING_PREFIX))).toHaveLength(1);
  });

  test("completed legacy data is removed without migration or replay", async () => {
    const f = fixture(); const journal = f.journal();
    const terminal = journal.stage(deletion(), () => 200); await journal.complete(terminal);
    f.values[recordKey("a")] = JSON.stringify({ v: 1, id: "a", symbol: "005930", want: { kind: "put", body: body("a", 42), reserved: true }, lastRevision: 42 });
    expect(await f.journal().recover("a")).toBeNull();
    expect(pendingKeys(f.values)).toEqual([]);
  });

  test("property order does not change the identity of a legitimate staged payload", async () => {
    const f = fixture(); const journal = f.journal();
    const original = journal.stage(input(), () => 100);
    if (original.want.kind !== "put") throw new Error("missing PUT");
    const reordered: Intent = { want: { reserved: true, body: original.want.body, kind: "put" }, order: original.order, uuid: original.uuid, symbol: original.symbol, lastRevision: original.lastRevision, id: original.id, v: 2 };
    expect(await journal.admit(reordered)).toBe(true);
    expect(journal.isSendable(reordered)).toBe(true);
    await journal.complete(reordered);
    expect(pendingKeys(f.values)).toEqual([]);
    expect(completion(f.values)).toMatchObject({ uuid: original.uuid, order: original.order });
  });

  test("exact payload identity protects a same-UUID stage and shared record from an altered ACK", async () => {
    const f = fixture(); const journal = f.journal();
    const original = journal.stage(input(), () => 100); await journal.admit(original);
    const changed = { ...original, order: original.order + 1 };
    const before = { ...f.values };
    await expect(journal.complete(changed)).rejects.toThrow();
    await expect(journal.admit(changed)).rejects.toThrow();
    expect(() => journal.isSendable(changed)).toThrow();
    expect(f.values).toEqual(before);
    f.values[recordKey("a")] = JSON.stringify(changed);
    await expect(journal.complete(original)).rejects.toThrow();
    expect(f.values[stageKey(original.uuid)]).toBeDefined();
    expect(f.values[completionKey("a")]).toBeUndefined();
  });

  test.each(["broken", JSON.stringify({ v: 1, id: "other", uuid: "x", order: 1, lastRevision: 1 }), JSON.stringify({ v: 1, id: "a", uuid: "x", order: -1, lastRevision: 1 })])("present malformed metadata fails explicitly on every public path", async (raw) => {
    const f = fixture(); const journal = f.journal(); const intent = journal.stage(input(), () => 100); await journal.admit(intent);
    f.values[completionKey("a")] = raw;
    expect(() => journal.snapshot()).toThrow();
    expect(() => journal.stage(input(), () => 100)).toThrow();
    expect(() => journal.isSendable(intent)).toThrow();
    await expect(journal.admit(intent)).rejects.toThrow();
    await expect(journal.recover("a")).rejects.toThrow();
    await expect(journal.complete(intent)).rejects.toThrow();
  });

  test("counter exhaustion and invalid reservation input write no stage", () => {
    const f = fixture({ [completionKey("a")]: JSON.stringify({ v: 1, id: "a", uuid: "x", order: Number.MAX_SAFE_INTEGER, lastRevision: 1 }) });
    expect(() => f.journal().stage(input(), () => 1)).toThrow("범위");
    expect(pendingKeys(f.values)).toEqual([]);
    expect(() => f.journal().stage({ ...input("b"), observedRevision: -1 }, () => 100)).toThrow();
    expect(() => f.journal().stage(input("b"), () => NaN)).toThrow();
    expect(pendingKeys(f.values)).toEqual([]);
  });

  test("Storage read/write errors and missing or rejected locks preserve explicit failures", async () => {
    const f = fixture(); const journal = f.journal();
    f.hooks.set = () => { throw new Error("quota"); };
    expect(() => journal.stage(input(), () => 100)).toThrow("quota");
    expect(f.values).toEqual({});
    f.hooks.set = () => {};
    const intent = journal.stage(input(), () => 100);
    f.hooks.set = (key) => { if (key === recordKey("a")) throw new Error("shared quota"); };
    await expect(journal.admit(intent)).rejects.toThrow("shared quota");
    expect(f.values[stageKey(intent.uuid)]).toBeDefined();
    f.hooks.get = () => { throw new Error("read failed"); };
    expect(() => journal.snapshot()).toThrow("read failed");
    await expect(journal.recover("a")).rejects.toThrow("read failed");
    f.hooks.get = () => {};
    vi.stubGlobal("navigator", {});
    try { await expect(new DrawingJournal(f.storage, undefined).admit(intent)).rejects.toThrow("잠금"); } finally { vi.unstubAllGlobals(); }
    const rejecting = { request: () => Promise.reject(new Error("lock failed")) };
    await expect(new DrawingJournal(f.storage, rejecting).admit(intent)).rejects.toThrow("lock failed");
    expect(f.values[stageKey(intent.uuid)]).toBeDefined();
  });
});
