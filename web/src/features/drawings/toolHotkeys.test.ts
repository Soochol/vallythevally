import { describe, expect, test } from "vitest";
import { actualKeys, DEFAULT_KEYS, toolActionId } from "../../lib/hotkeys";
import { TOOLS } from "../../chart/drawings/tools";
import { toolTitle } from "./DrawingToolbar";

describe("도구 제목의 단축키", () => {
  test("도구는 36개다", () => {
    expect(TOOLS).toHaveLength(36);
  });

  test.each(TOOLS.map((tool) => [tool.tool, tool] as const))("%s 제목에는 빈 단축키 괄호가 없다", (_, tool) => {
    for (const note of [undefined, "고정", "연속"]) {
      const title = toolTitle(tool, DEFAULT_KEYS, note);
      expect(title).not.toContain("()");
      expect(title.startsWith(tool.label)).toBe(true);
      expect(title.endsWith(` · ${note}`)).toBe(note !== undefined);
    }
  });

  test("단축키가 있는 도구의 제목은 그 단축키를 모두 보인다", () => {
    for (const tool of TOOLS) {
      const keys = DEFAULT_KEYS[toolActionId(tool.tool)]!;
      expect(toolTitle(tool, DEFAULT_KEYS).includes("("), tool.tool).toBe(keys.length > 0);
    }
    const trend = TOOLS.find((t) => t.tool === "trendline")!;
    expect(toolTitle(trend, DEFAULT_KEYS)).toBe(`${trend.label} (T / Alt+T)`);
  });

  test("바꾼 키는 제목에 보이고, 키가 없으면 글자와 괄호가 없다", () => {
    const trend = TOOLS.find((t) => t.tool === "trendline")!;
    expect(toolTitle(trend, actualKeys({ [toolActionId("trendline")]: ["KeyQ"] }))).toBe(`${trend.label} (Q)`);
    expect(toolTitle(trend, actualKeys({ [toolActionId("trendline")]: [] }))).toBe(trend.label);
  });
});
