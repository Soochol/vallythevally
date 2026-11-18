import { describe, expect, test } from "vitest";
import { TOOL_HOTKEYS } from "../../chart/drawings/hotkeys";
import { TOOLS } from "../../chart/drawings/tools";
import { toolTitle } from "./DrawingToolbar";

describe("도구 제목의 단축키", () => {
  test("도구는 36개다", () => {
    expect(TOOLS).toHaveLength(36);
  });

  test.each(TOOLS.map((tool) => [tool.tool, tool] as const))("%s 제목에는 빈 단축키 괄호가 없다", (_, tool) => {
    for (const note of [undefined, "고정", "연속"]) {
      const title = toolTitle(tool, note);
      expect(title).not.toContain("()");
      expect(title.startsWith(tool.label)).toBe(true);
      expect(title.endsWith(` · ${note}`)).toBe(note !== undefined);
    }
  });

  test("단축키가 있는 도구의 제목은 그 단축키를 모두 보인다", () => {
    for (const tool of TOOLS) {
      const keys = TOOL_HOTKEYS.filter((h) => h.tool === tool.tool).map((h) => h.keys);
      expect(toolTitle(tool).includes("("), tool.tool).toBe(keys.length > 0);
      for (const key of keys) expect(toolTitle(tool), tool.tool).toContain(key);
    }
  });

  test.each(TOOL_HOTKEYS.map((h) => [`${h.tool} ${h.code}`, h] as const))("%s 단축키 표시 문자열은 비어 있지 않다", (_, hotkey) => {
    expect(hotkey.keys.trim()).not.toBe("");
  });
});
