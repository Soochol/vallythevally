import type { Tool } from "../toolSpec";
import type { DrawingTool } from "../types";
import { hline } from "./hline";
import { trendline } from "./trendline";

export const TOOLS: readonly Tool[] = [
  trendline,
  hline,
];

const BY_ID: ReadonlyMap<DrawingTool, Tool> = new Map(TOOLS.map((t) => [t.tool, t]));

export function toolOf(tool: DrawingTool): Tool | undefined {
  return BY_ID.get(tool);
}

export function toolsByGroup(): ReadonlyMap<Tool["group"], readonly Tool[]> {
  const groups = new Map<Tool["group"], Tool[]>();
  for (const t of TOOLS) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return groups;
}
