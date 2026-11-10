import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { usePersistStore } from "../../stores/persist";
import { DrawingSync } from "./sync";
import { completionKey } from "./journal";
import type { Drawing, DrawingBody } from "./types";

const body: DrawingBody = { id: "new", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
const saved = (d: DrawingBody, revision: number): Drawing => ({ ...d, revision, updatedAt: 1 });
function deferred<T>() { let resolve: (value: T) => void = () => {}; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function setup(fetcher: typeof fetch, values: Record<string, string> = {}, readable = () => true) {
  const storage = Object.defineProperties(values, {
    getItem: { value: (k: string) => { if (!readable()) throw new Error("Storage temporarily unavailable"); return values[k] ?? null; } },
    setItem: { writable: true, value: (k: string, value: string) => { values[k] = value; } },
    removeItem: { value: (k: string) => { delete values[k]; } },
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { locks: { request: (_name: string, work: () => unknown) => Promise.resolve().then(work) } });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("fetch", fetcher);
  usePersistStore.getState().setPhase({ kind: "ready" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return { client, sync: new DrawingSync(client) };
}
afterEach(() => { vi.unstubAllGlobals(); });

test("failed initial list remains incomplete and retryable after a successful creation ACK", async () => {
  const list = deferred<Response>();
  let reads = 0;
  let accepted = false;
  const { sync } = setup(async (_input, options) => {
    if (options?.method === "PUT") { accepted = true; return Response.json(saved(body, 10)); }
    return reads++ === 0 ? list.promise : Response.json([saved(body, 10), saved({ ...body, id: "existing" }, 1)]);
  });
  const first = sync.load(body.symbol);
  sync.commit(0, [{ kind: "create", after: body }]);
  await vi.waitFor(() => expect(accepted).toBe(true));
  list.resolve(Response.json({ code: "internal", message: "list failed" }, { status: 500 }));
  await first;
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(sync.loadError(body.symbol)).toContain("HTTP 500");
  expect(sync.drawings(body.symbol).map((d) => d.id)).toEqual(["new"]);
  await sync.load(body.symbol);
  expect(sync.loadError(body.symbol)).toBeNull();
  expect(sync.drawings(body.symbol).map((d) => d.id)).toEqual(["new", "existing"]);
});

test("ACK also waits for a new load started as the previous load finishes", async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  let reads = 0; let accepted = false;
  const { client, sync } = setup(async (_input, options) => {
    if (options?.method === "PUT") { accepted = true; return Response.json(saved(body, 10)); }
    return reads++ === 0 ? first.promise : second.promise;
  });
  const loading = sync.load(body.symbol);
  void loading.then(() => { void sync.load(body.symbol); });
  sync.commit(0, [{ kind: "create", after: body }]);
  await vi.waitFor(() => expect(accepted).toBe(true));
  first.resolve(Response.json([saved({ ...body, id: "existing" }, 1)]));
  await loading;
  await vi.waitFor(() => expect(reads).toBe(2));
  second.resolve(Response.json([saved({ ...body, text: "newer other tab" }, 20), saved({ ...body, id: "existing" }, 1)]));
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(client.getQueryData<Drawing[]>(["drawings", body.symbol])?.find((d) => d.id === body.id)?.text).toBe("newer other tab");
  expect(sync.drawings(body.symbol)).toHaveLength(2);
});


test("retry after an initial storage scan failure restores the persisted intent without restamping", async () => {
  const intent = { v: 2, id: body.id, symbol: body.symbol, uuid: "recovered", order: 10, want: { kind: "put", body: { ...body, revision: 10 }, reserved: true }, lastRevision: 10 };
  const values = { "vv.unsaved.drawing-intent.recovered": JSON.stringify(intent) };
  let readable = false;
  const sent: unknown[] = [];
  const { sync } = setup(async (_input, options) => {
    if (options?.method === "PUT") sent.push(JSON.parse(String(options.body)));
    return Response.json(saved(body, 10));
  }, values, () => readable);
  expect(sync.save.kind).toBe("failed");
  sync.retry();
  expect(sync.save.kind).toBe("failed");
  expect(sent).toEqual([]);
  readable = true;
  sync.retry();
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(sent).toEqual([{ ...body, revision: 10 }]);
  expect(Object.keys(values)).toEqual([completionKey(body.id)]);
});


test("a rejected synchronous recovery write does not consume Undo history", async () => {
  const { sync } = setup(async (_input, options) => Response.json(options?.method === "PUT" ? saved(body, 10) : []));
  await sync.load(body.symbol);
  sync.commit(0, [{ kind: "create", after: body }]);
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  const history = sync.history(0);
  const nativeSet = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key.startsWith("vv.unsaved.drawing-intent.")) throw new Error("Storage write failed");
    nativeSet(key, value);
  };
  sync.undo(0);
  expect(sync.drawings(body.symbol)).toHaveLength(1);
  expect(sync.save.kind).toBe("failed");
  expect(sync.history(0)).toEqual(history);
});
