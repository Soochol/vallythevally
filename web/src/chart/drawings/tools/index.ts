import type { Tool } from "../toolSpec";
import type { DrawingTool } from "../types";
import { FIB_TOOLS } from "./groups/fib";
import { LINE_TOOLS } from "./groups/line";
import { MEASURE_TOOLS } from "./groups/measure";
import { NOTE_TOOLS } from "./groups/note";
import { PATTERN_TOOLS } from "./groups/pattern";
import { SHAPE_TOOLS } from "./groups/shape";

const TOOL_GROUPS: Readonly<Record<Tool["group"], readonly Tool[]>> = {
  line: LINE_TOOLS,
  fib: FIB_TOOLS,
  shape: SHAPE_TOOLS,
  note: NOTE_TOOLS,
  measure: MEASURE_TOOLS,
  pattern: PATTERN_TOOLS,
};

export const TOOLS: readonly Tool[] = Object.values(TOOL_GROUPS).flat();

const BY_ID: ReadonlyMap<DrawingTool, Tool> = new Map(TOOLS.map((t) => [t.tool, t]));

export function toolOf(tool: DrawingTool): Tool | undefined {
  return BY_ID.get(tool);
}

export function toolsByGroup(): ReadonlyMap<Tool["group"], readonly Tool[]> {
  const groups = new Map<Tool["group"], Tool[]>();
  for (const t of TOOLS) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return groups;
}
