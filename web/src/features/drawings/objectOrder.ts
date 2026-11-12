import type { DrawingSurface } from "../../chart/drawings/DrawingSurface";
import type { DrawingBody } from "../../chart/drawings/types";

export function moveObject(group: readonly DrawingBody[], id: string, direction: "forward" | "backward", surface: Pick<DrawingSurface, "reorder"> | undefined) {
  const index = group.findIndex((d) => d.id === id);
  if (index < 0) return;
  const neighbor = group[index + (direction === "forward" ? -1 : 1)];
  if (neighbor) surface?.reorder(id, direction, neighbor.id, direction === "forward" ? "above" : "below");
}
