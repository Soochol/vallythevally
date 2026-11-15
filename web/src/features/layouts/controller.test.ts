import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Layout } from "../../api/generated/Layout";
import type { LayoutInput } from "../../api/generated/LayoutInput";
import { ApiRequestError } from "../../api/http";
import { type Autosave, startAutosave } from "../../persist/autosave";
import { restoreLayout } from "../../persist/restore";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { createLayoutCommands, layoutNameProblem, useLayoutsStore } from "./controller";

const CELL = chartWindows(DEFAULT_LAYOUT)[0]!.id;
const stored = (id: string): Layout => ({ ...DEFAULT_LAYOUT, id, name: id, revision: 10, updatedAt: 0 });
const summary = (id: string) => ({ id, name: id, updatedAt: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
let autosave: Autosave;
let sent: LayoutInput[];
let put: (value: LayoutInput) => Promise<unknown>;
let install = vi.fn<Parameters<typeof createLayoutCommands>[0]["install"]>();
function setup(overrides: Partial<Parameters<typeof createLayoutCommands>[0]> = {}) {
  return createLayoutCommands({
    list: async () => [summary(DEFAULT_LAYOUT.id), summary("next")],
    get: async (id) => stored(id),
    put: async (value) => ({ ...value, updatedAt: 0 }), delete: async () => {},
    restore: (value) => restoreLayout(value, { symbolInfo: async () => { throw new Error("없음"); }, unsaved: () => null }),
    install, uuid: () => "copy", ...overrides,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  usePersistStore.setState({ phase: { kind: "ready" } });
  useLayoutsStore.setState({ phase: "ready", layouts: [summary(DEFAULT_LAYOUT.id), summary("next")] });
  useLayoutStore.getState().load(DEFAULT_LAYOUT);
  sent = [];
  put = async () => {};
  autosave = startAutosave({ put: async (_path, json) => { const value: LayoutInput = JSON.parse(json); sent.push(value); await put(value); }, toast: () => {}, revisions: { layout: 10, ui: 0, watchlist: 0 }, unsaved: () => undefined });
  install = vi.fn<Parameters<typeof createLayoutCommands>[0]["install"]>();
});
afterEach(() => { autosave.stop(); vi.useRealTimers(); });

test.each(["", "   ", "가".repeat(21), "😀".repeat(21)])("레이아웃 이름 길이를 거절한다: %s", (value) => {
  expect(layoutNameProblem(value, [])).not.toBeNull();
});
test("이름은 공백을 빼고 유니코드 코드 포인트를 세며 자기 이름만 중복에서 뺀다", () => {
  expect(layoutNameProblem(`  ${"😀".repeat(20)}  `, [])).toBeNull();
  expect(layoutNameProblem(" 기본 ", [{ id: "a", name: "기본", updatedAt: 0 }])).not.toBeNull();
  expect(layoutNameProblem(" 기본 ", [{ id: "a", name: "기본", updatedAt: 0 }], "a")).toBeNull();
});

test("보내지 못한 편집 저장에 실패하면 다음 레이아웃을 읽거나 열지 않는다", async () => {
  const get = vi.fn(async (id: string) => stored(id));
  put = async () => { throw new Error("저장 실패"); };
  useLayoutStore.getState().setPeriod(CELL, "W");
  await expect(setup({ get }).open("next")).rejects.toThrow("저장 실패");
  expect(get).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  expect(useLayoutStore.getState().layout.id).toBe(DEFAULT_LAYOUT.id);
});

test.each([false, true])("레이아웃 저장 순서가 거절되면 배경 저장 여부와 관계없이 전환하지 않는다: %s", async (background) => {
  put = async () => { throw new ApiRequestError("stale_revision", "더 새 레이아웃이 있습니다"); };
  useLayoutStore.getState().setPeriod(CELL, "W");
  if (background) await vi.advanceTimersByTimeAsync(1000);
  await expect(setup().open("next")).rejects.toThrow("더 새 레이아웃이 있습니다");
  expect(install).not.toHaveBeenCalled();
  expect(useLayoutStore.getState().layout.id).toBe(DEFAULT_LAYOUT.id);
  expect(chartWindows(useLayoutStore.getState().layout)[0]!.period).toBe("W");
  expect(usePersistStore.getState().saves.layout.kind).toBe("failed");
});

test.each([false, true])("지우기 결과를 확인할 수 없으면 저장을 멈추고 다음 명령에서 실제 존재 여부를 확인한다: %s", async (deleted) => {
  const deletion = deferred<void>();
  let available = false;
  const commands = setup({
    get: async (id) => {
      if (id === "next") return stored(id);
      if (!available) throw new ApiRequestError("network", "확인 연결 끊김");
      if (deleted) throw new ApiRequestError("not_found", "레이아웃이 없습니다");
      return stored(id);
    },
    delete: () => deletion.promise,
  });
  const deleting = commands.delete();
  const rejected = expect(deleting).rejects.toThrow("지우기 결과를 확인하지 못했습니다");
  await vi.advanceTimersByTimeAsync(0);
  useLayoutStore.getState().setPeriod(CELL, "W");
  deletion.reject(new ApiRequestError("network", "응답 끊김"));
  await rejected;
  autosave.flush();
  autosave.retry();
  await vi.advanceTimersByTimeAsync(70_000);
  expect(sent).toHaveLength(0);
  available = true;
  await commands.refresh();
  await vi.advanceTimersByTimeAsync(0);
  if (deleted) {
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]![0].layout.id).toBe("next");
    expect(sent).toHaveLength(0);
  } else {
    expect(install).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ id: DEFAULT_LAYOUT.id, windows: [{ period: "W" }, {}, {}, {}] });
  }
});

test("다음 레이아웃을 읽는 동안의 편집도 바꾸기 전에 원래 레이아웃에 저장하고 명령을 겹치지 않는다", async () => {
  const reading = deferred<Layout>();
  const get = vi.fn(() => reading.promise);
  const commands = setup({ get });
  const opening = commands.open("next");
  await vi.advanceTimersByTimeAsync(0);
  useLayoutStore.getState().setPeriod(CELL, "W");
  await commands.open("other");
  expect(get).toHaveBeenCalledTimes(1);
  reading.resolve(stored("next"));
  await opening;
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id: DEFAULT_LAYOUT.id, windows: [{ period: "W" }, {}, {}, {}] });
  expect(install).toHaveBeenCalledOnce();
});

test("삭제는 진행 중 PUT을 모두 기다리고 DELETE 동안 저장을 막으며 거절 뒤 새 편집을 저장한다", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const deletion = deferred<void>();
  put = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined);
  const remove = vi.fn(() => deletion.promise);
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  useLayoutStore.getState().setPeriod(CELL, "M");
  autosave.flush();
  const commands = setup({ delete: remove });
  const deleting = commands.delete();
  const rejected = expect(deleting).rejects.toThrow("범위 드로잉");
  await vi.advanceTimersByTimeAsync(0);
  second.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(remove).not.toHaveBeenCalled();
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(remove).toHaveBeenCalledOnce();
  const count = sent.length;
  useLayoutStore.getState().setPeriod(CELL, "Q");
  autosave.flush();
  autosave.retry();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent).toHaveLength(count);
  deletion.reject(new Error("범위 드로잉"));
  await rejected;
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.at(-1)).toMatchObject({ windows: [{ period: "Q" }, {}, {}, {}] });
  expect(install).not.toHaveBeenCalled();
});

test("이름 바꾸기 거절은 제안 이름을 자동 저장하지 않고 도중 편집과 배치 기록을 지킨다", async () => {
  const proposal = deferred<Layout>();
  const commands = setup({ put: () => proposal.promise });
  useLayoutStore.getState().closeWindow(DEFAULT_LAYOUT.windows[2]!.id);
  const renaming = commands.rename("새 이름");
  const rejection = expect(renaming).rejects.toThrow("중복");
  await vi.advanceTimersByTimeAsync(0);
  useLayoutStore.getState().setPeriod(CELL, "W");
  proposal.reject(new Error("중복"));
  await rejection;
  await vi.advanceTimersByTimeAsync(0);
  expect(useLayoutStore.getState().layout.name).toBe("기본");
  expect(useLayoutStore.getState().steps).toHaveLength(1);
  expect(sent.at(-1)).toMatchObject({ name: "기본", windows: [{ period: "W" }, {}, {}] });
});

test("거래소 확인을 기다리는 동안의 편집도 마지막 장벽으로 저장한다", async () => {
  const normalized = deferred<Awaited<ReturnType<typeof restoreLayout>>>();
  const normalize = vi.fn(() => normalized.promise);
  const commands = setup({ restore: normalize });
  const opening = commands.open("next");
  await vi.advanceTimersByTimeAsync(0);
  expect(normalize).toHaveBeenCalledOnce();
  useLayoutStore.getState().setPeriod(CELL, "W");
  normalized.resolve(await restoreLayout(stored("next"), { symbolInfo: async () => { throw new Error("없음"); }, unsaved: () => null }));
  await opening;
  expect(sent.at(-1)).toMatchObject({ id: DEFAULT_LAYOUT.id, windows: [{ period: "W" }, {}, {}, {}] });
  expect(install).toHaveBeenCalledOnce();
});

test("진행 중이던 저장이 실패하면 다음 레이아웃으로 바꾸지 않는다", async () => {
  const pending = deferred<void>();
  put = () => pending.promise;
  const get = vi.fn(async (id: string) => stored(id));
  useLayoutStore.getState().setPeriod(CELL, "W");
  await vi.advanceTimersByTimeAsync(1000);
  const opening = setup({ get }).open("next");
  const rejection = expect(opening).rejects.toThrow("진행 중 실패");
  pending.reject(new Error("진행 중 실패"));
  await rejection;
  expect(get).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

test("새 이름 저장은 처음 저장 뒤의 창·배치·연동 설정을 복사하고 그동안의 새 편집은 원본에 저장한다", async () => {
  const creation = deferred<Layout>();
  let copy: LayoutInput | undefined;
  const commands = setup({ put: async (value) => { copy = value; return creation.promise; } });
  useLayoutStore.getState().setPeriod(CELL, "W");
  const saving = commands.saveAs(" 복기 ");
  await vi.advanceTimersByTimeAsync(0);
  expect(copy).toMatchObject({ id: "copy", name: "복기", sync: DEFAULT_LAYOUT.sync, placement: DEFAULT_LAYOUT.placement });
  expect(copy?.windows[0]).toMatchObject({ period: "W" });
  useLayoutStore.getState().setPeriod(CELL, "M");
  creation.resolve({ ...stored("copy"), ...copy, updatedAt: 0 });
  await saving;
  expect(sent.map((value) => value.windows[0])).toMatchObject([{ period: "W" }, { period: "M" }]);
  expect(install.mock.calls[0]?.[0].layout.windows[0]).toMatchObject({ period: "W" });
});

test("기본 배치는 창 목록과 캔버스 배치를 지키고 배치 되돌리기로 돌아온다", () => {
  const previous = { ...DEFAULT_LAYOUT.placement, dock: { root: { kind: "group", id: "all", tabs: DEFAULT_LAYOUT.windows.map((window) => window.id), active: CELL }, floats: [] } } satisfies typeof DEFAULT_LAYOUT.placement;
  useLayoutStore.getState().load({ ...DEFAULT_LAYOUT, placement: previous });
  setup().resetPlacement();
  const changed = useLayoutStore.getState();
  expect(changed.layout.windows).toBe(DEFAULT_LAYOUT.windows);
  expect(changed.layout.placement.canvas).toBe(previous.canvas);
  expect(changed.layout.placement.dock?.root.kind).toBe("split");
  expect(changed.steps).toHaveLength(1);
  changed.undoArrangement();
  expect(useLayoutStore.getState().layout.placement).toBe(previous);
});

test("이름 바꾸기 성공은 도중 편집을 지키고 서버가 받은 번호 다음으로 저장한다", async () => {
  const proposal = deferred<Layout>();
  const commands = setup({ put: () => proposal.promise });
  const renaming = commands.rename(" 새 이름 ");
  await vi.advanceTimersByTimeAsync(0);
  useLayoutStore.getState().setPeriod(CELL, "W");
  const revision = Date.now() + 100_000;
  proposal.resolve({ ...stored(DEFAULT_LAYOUT.id), name: "새 이름", revision });
  await renaming;
  await vi.advanceTimersByTimeAsync(0);
  expect(useLayoutStore.getState().layout.name).toBe("새 이름");
  expect(sent.at(-1)).toMatchObject({ name: "새 이름", windows: [{ period: "W" }, {}, {}, {}] });
  expect(sent.at(-1)!.revision).toBeGreaterThan(revision);
});
