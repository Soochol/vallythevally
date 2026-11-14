import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Watchlists } from "../../api/generated/Watchlists";
import { sendJson } from "../../api/http";
import { startAutosave, type Autosave } from "../../persist/autosave";
import { usePersistStore } from "../../stores/persist";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { removalUndo } from "./removalUndo";

let autosave: Autosave;
let server: Watchlists;
let reads: number[];
let writes: Watchlists[];
let onRead: (() => void) | null;
let onWrite: (() => void) | null;
let putFailure: boolean;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", new EventTarget());
  server = { revision: 100, lists: [
    { id: "L", name: "기본", symbols: ["A", "X", "B"], groups: [] },
    { id: "other", name: "다른 목록", symbols: [], groups: [] },
  ] };
  reads = []; writes = []; onRead = null; onWrite = null; putFailure = false;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "PUT") {
      if (typeof init.body !== "string") throw new Error("Missing request body");
      const body: Watchlists = JSON.parse(init.body);
      writes.push(body);
      onWrite?.();
      if (putFailure) return Response.json({ error: { code: "internal", message: "실패" } }, { status: 500 });
      if (body.revision <= server.revision) return Response.json({ error: { code: "stale_revision", message: "경쟁 저장" } }, { status: 409 });
      server = structuredClone(body);
      return Response.json(server);
    }
    const snapshot = structuredClone(server);
    reads.push(snapshot.revision);
    onRead?.();
    return Response.json(snapshot);
  }));
  useWatchlistStore.getState().load(structuredClone(server.lists), server.revision);
  usePersistStore.getState().setSave("watchlist", { kind: "idle" });
  useSelectionStore.setState({ toast: null });
  autosave = startAutosave({
    put: (path, body, opts) => sendJson("PUT", path, body, opts),
    toast: (text) => useSelectionStore.getState().showToast(text),
    revisions: { layout: 0, ui: 0, watchlist: server.revision },
  });
});

afterEach(() => {
  autosave.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function prepare() {
  const undo = removalUndo(useWatchlistStore.getState().removeFromListWithUndo("L", "X"))!;
  await vi.advanceTimersByTimeAsync(0);
  expect(server.lists[0]!.symbols).toEqual(["A", "B"]);
  reads.length = 0; writes.length = 0;
  return undo;
}

test("늦은 GET의 revision+1이 거절되면 최신 목록에서 다시 삽입하고 복제 목록을 유지한다", async () => {
  const undo = await prepare();
  onRead = () => {
    onRead = null;
    server = { revision: server.revision + 10, lists: [...server.lists, { id: "copy", name: "복제", symbols: ["A", "B"], groups: [] }] };
  };
  undo.run();
  await vi.waitFor(() => expect(server.lists[0]!.symbols).toEqual(["A", "X", "B"]));
  await vi.waitFor(() => expect(usePersistStore.getState().saves.watchlist.kind).toBe("saved"));
  expect(writes.map((w) => w.revision)).toEqual(reads.map((r) => r + 1));
  expect(writes).toHaveLength(2);
  expect(server.lists[2]).toEqual({ id: "copy", name: "복제", symbols: ["A", "B"], groups: [] });
  expect(useWatchlistStore.getState().revision).toBe(server.revision);
  expect(useWatchlistStore.getState().lists).toEqual(server.lists);
  const accepted = server.revision;
  useWatchlistStore.getState().moveBy("L", { code: "B", groupId: null }, -1);
  await vi.advanceTimersByTimeAsync(0);
  expect(server.revision).toBeGreaterThan(accepted);
  expect(server.lists[0]!.symbols).toEqual(["A", "B", "X"]);
  expect(server.lists[2]!.id).toBe("copy");
});

test("충돌 뒤 L이 삭제되면 다시 쓰지 않고 알림을 남긴다", async () => {
  const undo = await prepare();
  onRead = () => { onRead = null; server = { revision: server.revision + 1, lists: server.lists.slice(1) }; };
  undo.run();
  await vi.waitFor(() => expect(useSelectionStore.getState().toast?.text).toBe("다른 곳에서 바뀌어 되돌리지 못했습니다"));
  expect(writes).toHaveLength(1);
  expect(server.lists).toEqual([{ id: "other", name: "다른 목록", symbols: [], groups: [] }]);
});

test("계속 경쟁하면 세 번만 PUT하고 성공으로 처리하지 않는다", async () => {
  const undo = await prepare();
  const before = structuredClone(server.lists);
  onWrite = () => { server.revision++; };
  undo.run();
  await vi.waitFor(() => expect(useSelectionStore.getState().toast?.text).toBe("다른 곳에서 바뀌어 되돌리지 못했습니다"));
  expect(writes).toHaveLength(3);
  expect(reads).toHaveLength(3);
  expect(server.lists).toEqual(before);
  expect(useWatchlistStore.getState().lists).toEqual(before);
});

test("조건부 PUT 500은 현재 목록과 서버 자료를 그대로 둔다", async () => {
  const undo = await prepare();
  const before = structuredClone(server);
  putFailure = true;
  undo.run();
  await vi.waitFor(() => expect(useSelectionStore.getState().toast?.text).toContain("되돌리지 않았습니다"));
  expect(writes).toHaveLength(1);
  expect(server).toEqual(before);
  expect(useWatchlistStore.getState().lists).toEqual(before.lists);
});

test("다른 곳에서 X가 다시 들어왔으면 충돌 재조회 뒤 덧붙이지 않는다", async () => {
  const undo = await prepare();
  onRead = () => { onRead = null; server = { revision: server.revision + 1, lists: [{ ...server.lists[0]!, symbols: ["A", "X", "B"] }, server.lists[1]!] }; };
  undo.run();
  await vi.waitFor(() => expect(useSelectionStore.getState().toast?.text).toBe("다른 곳에서 바뀌어 되돌리지 못했습니다"));
  expect(writes).toHaveLength(1);
  expect(server.lists[0]!.symbols).toEqual(["A", "X", "B"]);
});

test("GET을 받는 동안 로컬 순서를 바꾸면 늦은 응답은 삽입하지 않는다", async () => {
  const undo = await prepare();
  onRead = () => { onRead = null; useWatchlistStore.getState().moveBy("L", { code: "B", groupId: null }, -1); };
  undo.run();
  await vi.waitFor(() => expect(server.lists[0]!.symbols).toEqual(["B", "A"]));
  expect(writes.every((w) => !w.lists[0]!.symbols.includes("X"))).toBe(true);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["B", "A"]);
});

test("같은 되돌리기를 두 번 실행해도 조건부 PUT은 한 번뿐이다", async () => {
  const undo = await prepare();
  undo.run(); undo.run();
  await vi.waitFor(() => expect(server.lists[0]!.symbols).toEqual(["A", "X", "B"]));
  expect(writes).toHaveLength(1);
});

test("알림은 주기적으로 조회하지 않고 focus 또는 storage 때만 갱신한다", async () => {
  const undo = await prepare();
  const stop = undo.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads).toHaveLength(1);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(2);
  stop();
  window.dispatchEvent(new Event("storage"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(2);
});

test("그룹 안 종목을 되돌리면 서버에도 원래 그룹의 원래 자리로 돌아간다", async () => {
  const grouped = { ...server.lists[0]!, groups: [{ id: "G", name: "반도체", symbols: ["B", "X"] }] };
  server = { revision: 101, lists: [grouped, server.lists[1]!] };
  useWatchlistStore.getState().load(structuredClone(server.lists), server.revision);
  autosave.stop();
  autosave = startAutosave({
    put: (path, body, opts) => sendJson("PUT", path, body, opts),
    toast: (text) => useSelectionStore.getState().showToast(text),
    revisions: { layout: 0, ui: 0, watchlist: server.revision },
  });
  const undo = removalUndo(useWatchlistStore.getState().removeFromListWithUndo("L", "X"))!;
  await vi.advanceTimersByTimeAsync(0);
  expect(server.lists[0]).toMatchObject({ symbols: ["A", "B"], groups: [{ id: "G", symbols: ["B"] }] });
  onRead = () => { onRead = null; server = { revision: server.revision + 1, lists: [...server.lists, { id: "copy", name: "복제", symbols: [], groups: [] }] }; };
  undo.run();
  await vi.waitFor(() => expect(server.lists[0]).toEqual(grouped));
  expect(server.lists[2]!.id).toBe("copy");
  expect(useWatchlistStore.getState().lists).toEqual(server.lists);
});
