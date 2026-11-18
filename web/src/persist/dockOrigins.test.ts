import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defaultDock } from "../layout/dock/fit";
import { detachWindow, moveFloat } from "../layout/dock/floats";
import { groupOfWindow, putTab } from "../layout/dock/tree";
import { windowId } from "../layout/kinds";
import { DEFAULT_LAYOUT, useLayoutStore, windowRefs, type EditableLayout } from "../stores/layout";
import { useUiStore } from "../stores/ui";
import { dockOriginsKey, readDockOrigins, writeDockOrigins } from "./dockOrigins";

const memory = new Map<string, string>();
const state = () => useLayoutStore.getState();
const id = windowId("screener");
const rect = { x: .2, y: .2, w: .3, h: .5 };

function customFloat(): EditableLayout {
  const layout = structuredClone(DEFAULT_LAYOUT);
  const dock = defaultDock(windowRefs(layout.windows));
  const custom = putTab(dock, id, "g1");
  return { ...layout, placement: { ...layout.placement, dock: detachWindow(custom, id, rect) } };
}

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  useUiStore.getState().setLayoutMode("dock");
  state().load(structuredClone(DEFAULT_LAYOUT));
});
afterEach(() => vi.unstubAllGlobals());

test("같은 브라우저의 정확히 같은 문서만 원래 사용자 묶음을 복원한다", () => {
  const layout = customFloat();
  writeDockOrigins(layout, new Map([[id, "g1"]]));
  expect(readDockOrigins(structuredClone(layout)).get(id)).toBe("g1");
  const reordered = { placement: layout.placement, windows: layout.windows, sync: layout.sync, name: layout.name, id: layout.id };
  expect(readDockOrigins(reordered).get(id)).toBe("g1");
  expect(readDockOrigins({ ...layout, name: "외부 교체" }).size).toBe(0);
  expect(readDockOrigins({ ...layout, id: "other-layout" }).size).toBe(0);
  expect(readDockOrigins({ ...layout, windows: layout.windows.filter((window) => window.id !== id) }).size).toBe(0);
  expect(readDockOrigins({ ...layout, placement: { ...layout.placement, dock: defaultDock(windowRefs(layout.windows)) } }).size).toBe(0);
});

test("없거나 깨진 값과 실제 떠 있는 창·묶음 소유권을 어기는 항목은 기본 자리로 돌아간다", () => {
  const layout = customFloat();
  const key = dockOriginsKey(layout.id);
  expect(readDockOrigins(layout).size).toBe(0);
  for (const raw of ["{", "null", "[]", '{"v":2}', '{"v":1,"document":null,"origins":[]}']) {
    memory.set(key, raw);
    expect(readDockOrigins(layout).size).toBe(0);
  }
  for (const entries of [[[id, "missing"]], [[windowId("missing"), "g1"]], [[windowId("cell-0"), "g1"]], [[id, "g1"], [id, "g1"]]]) {
    writeDockOrigins(layout, new Map([[id, "g1"]]));
    const hints = JSON.parse(memory.get(key)!);
    hints.origins = entries;
    memory.set(key, JSON.stringify(hints));
    expect(readDockOrigins(layout).size).toBe(0);
  }
});

test("저장소 읽기·쓰기·접근 실패는 메모리의 원래 묶음과 붙이기를 막지 않는다", () => {
  const layout = customFloat();
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("read"); }, setItem: () => { throw new Error("write"); }, removeItem: () => { throw new Error("remove"); } });
  expect(readDockOrigins(layout).size).toBe(0);
  expect(() => writeDockOrigins(layout, new Map([[id, "g1"]]))).not.toThrow();
  expect(() => writeDockOrigins(layout, new Map())).not.toThrow();
  state().load(structuredClone(DEFAULT_LAYOUT));
  const dock = putTab(defaultDock(windowRefs(state().layout.windows)), id, "g1");
  state().setDock(dock);
  state().commitDock({ session: state().session, expected: dock, next: detachWindow(dock, id, rect) });
  expect(state().dockOrigins.get(id)).toBe("g1");
  state().attachFloat(id);
  expect(groupOfWindow(state().layout.placement.dock!.root, id)?.id).toBe("g1");
  vi.stubGlobal("localStorage", undefined);
  expect(readDockOrigins(layout).size).toBe(0);
  expect(() => writeDockOrigins(layout, new Map([[id, "g1"]]))).not.toThrow();
});

test("설정·종목·연동·이름 변경과 모드 왕복 뒤에도 최신 문서의 힌트를 복원한다", () => {
  const dock = putTab(defaultDock(windowRefs(state().layout.windows)), id, "g1");
  state().setDock(dock);
  state().commitDock({ session: state().session, expected: dock, next: detachWindow(dock, id, rect) });
  const chart = windowId("cell-0");
  state().rename("새 이름");
  state().setPeriod(chart, "W");
  state().setStyle(chart, "line");
  state().setSymbol(chart, { code: "005930" });
  state().setLink(id, "b");
  useUiStore.getState().setLayoutMode("canvas");
  useUiStore.getState().setLayoutMode("dock");
  const snapshot = structuredClone(state().layout);
  state().load(snapshot);
  expect(state().dockOrigins.get(id)).toBe("g1");
  state().attachFloat(id);
  expect(groupOfWindow(state().layout.placement.dock!.root, id)?.id).toBe("g1");
  expect(memory.has(dockOriginsKey(snapshot.id))).toBe(false);
});

test("되돌리기·닫기·기본 배치는 저장한 힌트를 같이 바꾸고 다른 레이아웃은 자기 힌트만 쓴다", () => {
  const layout = customFloat();
  writeDockOrigins(layout, new Map([[id, "g1"]]));
  state().load(layout);
  const dock = state().layout.placement.dock!;
  state().commitDock({ session: state().session, expected: dock, next: moveFloat(dock, id, { ...rect, x: .4 }) });
  state().attachFloat(id);
  state().undoArrangement();
  expect(readDockOrigins(state().layout).get(id)).toBe("g1");
  state().closeWindow(id);
  expect(memory.has(dockOriginsKey(layout.id))).toBe(false);
  state().undoArrangement();
  expect(readDockOrigins(state().layout).get(id)).toBe("g1");
  const snapshot = structuredClone(state().layout);
  state().load({ ...structuredClone(DEFAULT_LAYOUT), id: "another-layout" });
  expect(state().dockOrigins.size).toBe(0);
  state().load(snapshot);
  expect(state().dockOrigins.get(id)).toBe("g1");
  state().setDock(defaultDock(windowRefs(state().layout.windows)));
  expect(memory.has(dockOriginsKey(layout.id))).toBe(false);
  state().undoArrangement();
  expect(readDockOrigins(state().layout).get(id)).toBe("g1");
});

test("사라진 묶음 id를 다시 써도 힌트를 되살리지 않는다", () => {
  const layout = customFloat();
  writeDockOrigins(layout, new Map([[id, "g1"]]));
  state().load(layout);
  state().showWindow("indicators");
  state().showWindow("watchlist", "g1");
  const dock = state().layout.placement.dock!;
  const moved = putTab(dock, windowId("cell-0"), "g2");
  state().setDock(putTab(moved, windowId("watchlist"), "g2"));
  expect(state().dockOrigins.size).toBe(0);
  const reused = { ...state().layout.placement.dock!, root: { kind: "group" as const, id: "g1", tabs: [windowId("cell-0"), windowId("watchlist"), windowId("indicators")], active: windowId("cell-0") } };
  state().setDock(reused);
  expect(readDockOrigins(state().layout).size).toBe(0);
  state().load(structuredClone(state().layout));
  expect(state().dockOrigins.size).toBe(0);
});
