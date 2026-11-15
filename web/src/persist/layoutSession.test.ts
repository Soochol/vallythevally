import { afterEach, expect, test, vi } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../stores/layout";
import { usePersistStore } from "../stores/persist";
import { type Autosave, serverMayLackChart, startAutosave } from "./autosave";
import { clearUnsaved, readUnsaved, writeUnsaved } from "./unsaved";

let active: Autosave | undefined;
afterEach(() => { active?.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each([true, false])("다음 레이아웃의 첫 저장은 새 경로와 revision을 쓰고 옛 응답에 영향받지 않는다: %s", async (ok) => {
  vi.useFakeTimers();
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  let resolve = () => {};
  let reject = (_e: unknown) => {};
  const sent: { path: string; body: { revision: number; id: string } }[] = [];
  const drafts: string[] = [];
  active = startAutosave({
    put: (path, json) => {
      sent.push({ path, body: JSON.parse(json) });
      return sent.length === 1 ? new Promise<void>((a, b) => { resolve = a; reject = b; }) : Promise.resolve();
    },
    toast: () => {}, revisions: { layout: 1, ui: 1, watchlist: 1 },
    unsaved: () => ({ write: (u) => drafts.push(u.path), clear: () => drafts.push("clear") }),
  });
  const cell = chartWindows(DEFAULT_LAYOUT)[0]!.id;
  useLayoutStore.getState().setPeriod(cell, "W");
  await vi.advanceTimersByTimeAsync(1000);
  const next = { ...DEFAULT_LAYOUT, id: "next" };
  useLayoutStore.getState().load(next);
  const revision = Date.now() + 100_000;
  active.replaceLayout(next, revision, [cell]);
  useLayoutStore.getState().setPeriod(cell, "M");
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent[1]).toMatchObject({ path: "/api/layouts/next", body: { id: "next" } });
  expect(sent[1]!.body.revision).toBeGreaterThan(revision);
  const state = usePersistStore.getState().saves.layout;
  const draftCalls = [...drafts];
  if (ok) resolve(); else reject(new Error("이전 실패"));
  await vi.advanceTimersByTimeAsync(100_000);
  expect(usePersistStore.getState().saves.layout).toEqual(state);
  expect(drafts).toEqual(draftCalls);
  expect(serverMayLackChart(cell)).toBe(false);
  expect(sent).toHaveLength(2);
});

test("같은 번호의 다른 레이아웃 미저장본은 지우지 않는다", () => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  writeUnsaved("layout", { path: "/api/layouts/other", revision: 10, body: "{}" });
  clearUnsaved("layout", 10, "/api/layouts/current");
  expect(readUnsaved("layout")?.path).toBe("/api/layouts/other");
  clearUnsaved("layout", 10, "/api/layouts/other");
  expect(readUnsaved("layout")).toBeNull();
});
