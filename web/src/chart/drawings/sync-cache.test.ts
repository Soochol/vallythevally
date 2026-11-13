import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { renameObject } from "./objects";
import { hline } from "./tools/hline";
import { copy, paste } from "./clipboard";
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


test("drawing edits, clone, object visibility and delete-toast Undo keep persisted names and styles", async () => {
  const remote = new Map<string, Drawing>([[body.id, saved(body, 1)]]);
  const { sync } = setup(async (input, options) => {
    if (options?.method === "PUT") {
      const next: DrawingBody = JSON.parse(String(options.body));
      const value = saved(next, next.revision);
      remote.set(next.id, value); return Response.json(value);
    }
    if (options?.method === "DELETE") { remote.delete(String(input).split("/").at(-1) ?? ""); return new Response(null, { status: 204 }); }
    return Response.json([...remote.values()]);
  });
  await sync.load(body.symbol);
  const current = () => { const d = sync.drawings(body.symbol).find((d) => d.id === body.id); if (!d) throw new Error("드로잉이 필요합니다"); return d; };
  const edit = async (change: (before: DrawingBody) => DrawingBody) => {
    const before = current(); sync.commit(0, [{ kind: "update", before, after: change(before) }]);
    await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  };
  await edit((d) => renameObject(d, "지지선"));
  await edit((d) => ({ ...d, style: hline.bar.lineColor?.set(d.style, "#123456") }));
  await edit((d) => ({ ...d, style: hline.bar.width?.set(d.style, 5) }));
  await edit((d) => ({ ...d, style: hline.bar.dash?.set(d.style, "dotted"), locked: true }));
  const clip = copy([current()], body.symbol); if (!clip) throw new Error("복사할 드로잉이 필요합니다");
  const clone = paste(clip, { symbol: body.symbol, scope: body.scope, topZ: 1, newId: () => "clone", shiftBars: (t, n) => t + n });
  sync.commit(0, clone.bodies.map((after) => ({ kind: "create", after })));
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(remote.get("clone")).toMatchObject({ locked: false, z: 2, style: { objectName: "지지선", line: { color: "#123456", width: 5, dash: "dotted" } } });
  await edit((d) => ({ ...d, hidden: true, locked: false, z: 3 }));
  expect(remote.get(body.id)).toMatchObject({ hidden: true, locked: false, z: 3 });
  const before = current();
  sync.commitWithUndo(0, [{ kind: "delete", before }], "드로잉을 지웠습니다");
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(remote.has(body.id)).toBe(false);
  const undo = useSelectionStore.getState().toast?.undo;
  expect(undo?.available()).toBe(true);
  undo?.run();
  await vi.waitFor(() => expect(sync.save.kind).toBe("saved"));
  expect(remote.get(body.id)).toMatchObject({ hidden: true, z: 3, style: { objectName: "지지선", line: { color: "#123456", width: 5, dash: "dotted" } } });
  expect(undo?.available()).toBe(false);
  await sync.load(body.symbol);
  expect(sync.drawings(body.symbol).map((d) => d.id)).toEqual(["clone", body.id]);
});

test("an empty change asks nothing of the save phase while a real one still waits for recovery", () => {
  const { sync } = setup(async () => Response.json([]));
  usePersistStore.getState().setPhase({ kind: "restoring" });
  useSelectionStore.setState({ toast: null });
  expect(sync.commit(0, [])).toBe(false);
  expect(useSelectionStore.getState().toast).toBeNull();
  expect(sync.commit(0, [{ kind: "create", after: body }])).toBe(false);
  expect(useSelectionStore.getState().toast?.text).toBe("서버 연결을 복구한 뒤 드로잉을 편집하세요");
});
