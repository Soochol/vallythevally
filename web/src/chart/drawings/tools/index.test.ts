import { expect, test } from "vitest";
import type { Placement, Tool } from "../toolSpec";
import { type DrawingTool, type PointCount, TOOL_POINTS } from "../types";
import { TOOLS, toolOf } from "./index";

function countOf(p: Placement): PointCount {
  switch (p.kind) {
    case "points":
      return { kind: "exact", n: p.count };
    case "polyline":
    case "freehand":
      return { kind: "range", min: p.min, max: p.max };
  }
}

test.each(TOOLS.map((t) => [t.tool, t] as const))("%s의 점 수는 서버 표(§5.3)와 같다", (id, tool) => {
  expect(countOf(tool.placement)).toEqual(TOOL_POINTS[id]);
});

test("서버 표는 도구 21개다", () => {
  expect(Object.keys(TOOL_POINTS)).toHaveLength(21);
});

test("등록 표에 같은 도구가 두 번 없다", () => {
  const ids = TOOLS.map((t) => t.tool);
  expect(new Set(ids).size).toBe(ids.length);
  for (const t of TOOLS) expect(toolOf(t.tool)).toBe(t);
});

test("모든 도구의 기본 스타일은 parseStyle을 거쳐도 같다", () => {
  for (const t of TOOLS) expect(t.parseStyle(t.defaultStyle())).toEqual(t.defaultStyle());
});

test("등록되지 않은 도구는 없다고 답한다", () => {
  const registered = new Set(TOOLS.map((t) => t.tool));
  for (const id of Object.keys(TOOL_POINTS) as DrawingTool[]) expect(toolOf(id) === undefined).toBe(!registered.has(id));
});

const GROUP_ORDER: readonly Tool["group"][] = ["line", "fib", "shape", "note", "measure"];
const GROUP_FILES = import.meta.glob<Record<string, unknown>>(["./groups/**/*.{ts,tsx}", "!./groups/**/*.test.{ts,tsx}"], { eager: true });
const fileGroup = (path: string) => path.slice("./groups/".length).replace(/\.tsx?$/, "");
const toolsOfFile = (path: string): readonly Tool[] => {
  const name = `${fileGroup(path).toUpperCase()}_TOOLS`;
  const exports = GROUP_FILES[path]!;
  expect(Object.keys(exports), `${path}는 ${name} 하나만 내보낸다`).toEqual([name]);
  expect(exports[name], `${path}의 ${name}`).toBeInstanceOf(Array);
  return exports[name] as readonly Tool[];
};

test("그룹 파일마다 그 이름의 그룹 도구만 들어 있다", () => {
  expect(Object.keys(GROUP_FILES).map(fileGroup).sort()).toEqual([...GROUP_ORDER].sort());
  for (const path of Object.keys(GROUP_FILES)) {
    for (const t of toolsOfFile(path)) expect(t.group, `${path}의 ${t.tool}`).toBe(fileGroup(path));
  }
});

test("등록 표는 선, 피보나치, 도형, 주석, 측정 그룹 순서로 이어진다", () => {
  const expected = GROUP_ORDER.flatMap((group) => toolsOfFile(`./groups/${group}.ts`));
  expect(TOOLS).toEqual(expected);
});
