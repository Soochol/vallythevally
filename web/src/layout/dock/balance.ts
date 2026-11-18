import type { DockNode, DockPlacement } from "../placement";
import { alongOf, gutterAt, nodeAt, type SplitDir } from "./axis";
import { dockMinSize, heldMinSize, layoutDock, ratioForLead, wholePixels, type DockSpace } from "./geometry";
import { updateSplit, type SplitNode, type SplitPath } from "./tree";

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function evenLengths(mins: readonly number[], available: number): number[] | null {
  if (sum(mins) > available) return null;
  const pinned = new Set<number>();
  for (;;) {
    const free = mins.map((_, index) => index).filter((index) => !pinned.has(index));
    if (free.length === 0) return [...mins];
    const pool = available - sum([...pinned].map((index) => mins[index] ?? 0));
    const level = Math.floor(pool / free.length);
    const over = free.filter((index) => (mins[index] ?? 0) > level);
    if (over.length === 0) {
      const extra = pool - level * free.length;
      return mins.map((min, index) => (pinned.has(index) ? min : level + (free.indexOf(index) < extra ? 1 : 0)));
    }
    over.forEach((index) => pinned.add(index));
  }
}

const bundlesOf = (node: DockNode, dir: SplitDir): DockNode[] =>
  node.kind === "split" && node.dir === dir ? [...bundlesOf(node.first, dir), ...bundlesOf(node.second, dir)] : [node];

function chainTop(root: DockNode, path: SplitPath, dir: SplitDir): SplitPath {
  let top = path;
  while (top.length > 0) {
    const parent = nodeAt(root, top.slice(0, -1));
    if (parent?.kind !== "split" || parent.dir !== dir) break;
    top = top.slice(0, -1);
  }
  return top;
}

type MinOf = typeof heldMinSize;

function equalizeWith(dock: DockPlacement, path: SplitPath, space: DockSpace, minOf: MinOf): DockPlacement {
  const px = wholePixels(space);
  const box = gutterAt(layoutDock(dock.root, px.area, px.gap), path);
  if (!box) return dock;
  const dir = box.node.dir;
  const topPath = chainTop(dock.root, path, dir);
  const top = gutterAt(layoutDock(dock.root, px.area, px.gap), topPath);
  if (!top) return dock;
  const bundles = bundlesOf(top.node, dir);
  const available = alongOf(dir, top.bounds) - (bundles.length - 1) * px.gap;
  const lengths = evenLengths(
    bundles.map((bundle) => alongOf(dir, minOf(bundle, px))),
    available,
  );
  if (!lengths) return dock;
  const rebuild = (split: SplitNode, part: readonly number[]): SplitNode => {
    const firstCount = bundlesOf(split.first, dir).length;
    const firstPart = part.slice(0, firstCount);
    const secondPart = part.slice(firstCount);
    const along = sum(part) + (part.length - 1) * px.gap;
    const lead = sum(firstPart) + (firstPart.length - 1) * px.gap;
    const next = (child: DockNode, childPart: readonly number[]) => (child.kind === "split" && child.dir === dir ? rebuild(child, childPart) : child);
    return { ...split, ratio: ratioForLead(lead, along, px.gap), first: next(split.first, firstPart), second: next(split.second, secondPart) };
  };
  return { ...dock, root: updateSplit(dock.root, topPath, (split) => rebuild(split, lengths)) };
}

export const equalizeRun = (dock: DockPlacement, path: SplitPath, space: DockSpace): DockPlacement => equalizeWith(dock, path, space, heldMinSize);

export function equalizeAll(dock: DockPlacement, space: DockSpace): DockPlacement {
  const px = wholePixels(space);
  const tops = layoutDock(dock.root, px.area, px.gap).gutters.filter((gutter) => {
    const parent = nodeAt(dock.root, gutter.path.slice(0, -1));
    return gutter.path.length === 0 || (parent?.kind === "split" && parent.dir !== gutter.node.dir);
  });
  return tops.reduce((current, gutter) => equalizeWith(current, gutter.path, space, dockMinSize), dock);
}
