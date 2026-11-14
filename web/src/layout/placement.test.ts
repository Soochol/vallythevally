import { afterEach, expect, test, vi } from "vitest";
import { MAX_DOCK_DEPTH, parsePlacement } from "./placement";

afterEach(() => vi.restoreAllMocks());

const silence = () => vi.spyOn(console, "warn").mockImplementation(() => {});

const group = (id: string, tabs: string[], active = tabs[0]) => ({ kind: "group", id, tabs, active });

const dock = {
  root: {
    kind: "split",
    dir: "row",
    ratio: 0.7,
    first: group("main", ["c1", "c2"], "c2"),
    second: { kind: "split", dir: "column", ratio: 0.5, first: group("side", ["w", "s"]), second: group("tools", ["o"]) },
  },
  floats: [{ window: "i", rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.4 } }],
};

const canvas = {
  rects: { c1: { x: 0, y: 0, w: 0.7, h: 1 }, w: { x: 0.7, y: 0, w: 0.3, h: 0.5 } },
  order: ["c1", "w"],
};

const nested = (splits: number): unknown =>
  splits === 0 ? group("leaf", ["c1"]) : { kind: "split", dir: "row", ratio: 0.5, first: nested(splits - 1), second: group(`g${splits}`, ["w"]) };

test("올바른 배치는 그대로 읽어 같은 JSON으로 돌아간다", () => {
  const warn = silence();
  const raw = { v: 1, dock, canvas };
  expect(JSON.parse(JSON.stringify(parsePlacement(JSON.parse(JSON.stringify(raw)))))).toEqual(raw);
  expect(JSON.parse(JSON.stringify(parsePlacement({ v: 1, dock: null, canvas: null })))).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).not.toHaveBeenCalled();
});

test.each([null, undefined, [], [{ v: 1 }], "x", 1, { v: 2, dock, canvas }, { v: "1", dock, canvas }, { dock, canvas }])("%j는 빈 배치가 된다", (raw) => {
  const warn = silence();
  expect(parsePlacement(raw)).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).toHaveBeenCalledOnce();
});

test("마이그레이션이 남긴 빈 객체는 경고 없이 빈 배치가 된다", () => {
  const warn = silence();
  expect(parsePlacement({})).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).not.toHaveBeenCalled();
});

const badDocks: [string, unknown][] = [
  ["빈 tabs", { ...dock, root: group("main", [], "c1") }],
  ["tabs 밖의 active", { ...dock, root: group("main", ["c1"], "c9") }],
  ["ratio 0", { ...dock, root: { ...dock.root, ratio: 0 } }],
  ["ratio 1", { ...dock, root: { ...dock.root, ratio: 1 } }],
  ["음수 ratio", { ...dock, root: { ...dock.root, ratio: -0.2 } }],
  ["NaN ratio", { ...dock, root: { ...dock.root, ratio: NaN } }],
  ["겹치는 묶음 id", { ...dock, root: { ...dock.root, second: group("main", ["w"]) } }],
  ["모르는 kind", { ...dock, root: { ...group("main", ["c1"]), kind: "stack" } }],
  ["모르는 dir", { ...dock, root: { ...dock.root, dir: "diagonal" } }],
  ["문자열이 아닌 탭", { ...dock, root: group("main", [1 as unknown as string], "1") }],
  ["떠 있는 창의 무한한 좌표", { ...dock, floats: [{ window: "i", rect: { x: Infinity, y: 0, w: 0.3, h: 0.3 } }] }],
  ["떠 있는 창 id 없음", { ...dock, floats: [{ rect: { x: 0, y: 0, w: 0.3, h: 0.3 } }] }],
  ["floats 없음", { root: dock.root }],
  ["root 없음", { floats: [] }],
  ["깊이 33", { root: nested(MAX_DOCK_DEPTH + 1), floats: [] }],
];

test.each(badDocks)("dock의 %s는 dock만 버리고 canvas는 남긴다", (_, bad) => {
  const warn = silence();
  expect(parsePlacement({ v: 1, dock: bad, canvas })).toEqual({ v: 1, dock: null, canvas });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("dock");
});

const badCanvases: [string, unknown][] = [
  ["NaN 좌표", { ...canvas, rects: { ...canvas.rects, w: { x: NaN, y: 0, w: 0.3, h: 0.5 } } }],
  ["숫자가 아닌 크기", { ...canvas, rects: { c1: { x: 0, y: 0, w: "0.7", h: 1 } } }],
  ["빠진 h", { ...canvas, rects: { c1: { x: 0, y: 0, w: 0.7 } } }],
  ["배열 rects", { ...canvas, rects: [] }],
  ["문자열이 아닌 order", { ...canvas, order: ["c1", 2] }],
  ["order 없음", { rects: canvas.rects }],
];

test.each(badCanvases)("canvas의 %s는 canvas만 버리고 dock은 남긴다", (_, bad) => {
  const warn = silence();
  expect(parsePlacement({ v: 1, dock, canvas: bad })).toEqual({ v: 1, dock, canvas: null });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("canvas");
});

test("나눔 깊이 32까지는 읽고 33부터 버린다", () => {
  const warn = silence();
  expect(parsePlacement({ v: 1, dock: { root: nested(MAX_DOCK_DEPTH), floats: [] }, canvas: null }).dock?.root).toEqual(nested(MAX_DOCK_DEPTH));
  expect(warn).not.toHaveBeenCalled();
  expect(parsePlacement({ v: 1, dock: { root: nested(MAX_DOCK_DEPTH + 1), floats: [] }, canvas: null }).dock).toBeNull();
});

test("둘 다 틀리면 둘 다 버리고 한 번에 남긴다", () => {
  const warn = silence();
  expect(parsePlacement({ v: 1, dock: { root: group("a", []), floats: [] }, canvas: { rects: {}, order: null } })).toEqual({ v: 1, dock: null, canvas: null });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("dock, canvas");
});

test("JSON의 __proto__ 키도 창 자리 하나로 읽는다", () => {
  const raw = JSON.parse('{"v":1,"dock":null,"canvas":{"rects":{"__proto__":{"x":0,"y":0,"w":1,"h":1}},"order":["__proto__"]}}');
  const parsed = parsePlacement(raw);
  expect(Object.getPrototypeOf(parsed.canvas?.rects)).toBe(Object.prototype);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw);
});
