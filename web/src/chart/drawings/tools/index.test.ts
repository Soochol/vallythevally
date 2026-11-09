import { expect, test } from "vitest";
import type { Placement } from "../toolSpec";
import { type PointCount, TOOL_POINTS } from "../types";
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
  expect(toolOf("brush")).toBeUndefined();
});
