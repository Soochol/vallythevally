import type { DockLayout, GutterBox, Size } from "./geometry";
import { dockMinSize, type DockSpace } from "./geometry";
import type { DockNode } from "../placement";
import type { SplitNode, SplitPath } from "./tree";

export type SplitDir = SplitNode["dir"];

export const alongOf = (dir: SplitDir, size: Size): number => (dir === "row" ? size.w : size.h);

export const gutterAt = (layout: DockLayout, path: SplitPath): GutterBox | undefined =>
  layout.gutters.find((gutter) => gutter.path.join() === path.join());

export function nodeAt(root: DockNode, path: SplitPath): DockNode | null {
  let node: DockNode = root;
  for (const branch of path) {
    if (node.kind !== "split") return null;
    node = node[branch];
  }
  return node;
}

export type LeadRange = { min: number; max: number };

export function leadRange(box: GutterBox, space: Pick<DockSpace, "gap" | "windows">): LeadRange | null {
  const along = alongOf(box.node.dir, box.bounds);
  const min = alongOf(box.node.dir, dockMinSize(box.node.first, space));
  const max = along - space.gap - alongOf(box.node.dir, dockMinSize(box.node.second, space));
  return min > max ? null : { min, max };
}
