import type { DockNode, DockPlacement } from "../placement";
import { alongOf, gutterAt, leadRange, type SplitDir } from "./axis";
import { dockMinSize, layoutDock, leadLength, ratioForLead, wholePixels, type DividerResult, type DockSpace } from "./geometry";
import { presetLead, type SharePreset } from "./stops";
import { updateSplit, type SplitPath } from "./tree";

type Metrics = Pick<DockSpace, "gap" | "windows">;

function shrinkLargestFirst(lengths: readonly number[], mins: readonly number[], target: number): number[] {
  const at = (cap: number) => lengths.map((length, index) => Math.min(length, Math.max(mins[index] ?? 0, cap)));
  const total = (cap: number) => at(cap).reduce((sum, length) => sum + length, 0);
  let low = 0;
  let high = Math.max(...lengths);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (total(mid) <= target) low = mid;
    else high = mid - 1;
  }
  const result = at(low);
  let spare = target - total(low);
  const order = lengths.map((_, index) => index).sort((a, b) => (lengths[b] ?? 0) - (lengths[a] ?? 0) || a - b);
  for (const index of order) {
    if (spare <= 0) break;
    if (result[index] === low && (lengths[index] ?? 0) > low) {
      result[index] = low + 1;
      spare -= 1;
    }
  }
  return result;
}

function shrinkNode(node: DockNode, oldLength: number, newLength: number, dir: SplitDir, space: Metrics): DockNode {
  if (node.kind === "group" || newLength >= oldLength) return node;
  if (node.dir !== dir) {
    return {
      ...node,
      first: shrinkNode(node.first, oldLength, newLength, dir, space),
      second: shrinkNode(node.second, oldLength, newLength, dir, space),
    };
  }
  const lead = leadLength(node.ratio, oldLength, space.gap);
  const secondLength = oldLength - lead - Math.min(space.gap, oldLength - lead);
  const content = newLength - space.gap;
  const [firstLength = lead, nextSecond = secondLength] = shrinkLargestFirst(
    [lead, secondLength],
    [alongOf(dir, dockMinSize(node.first, space)), alongOf(dir, dockMinSize(node.second, space))],
    content,
  );
  return {
    ...node,
    ratio: ratioForLead(firstLength, newLength, space.gap),
    first: shrinkNode(node.first, lead, firstLength, dir, space),
    second: shrinkNode(node.second, secondLength, nextSecond, dir, space),
  };
}

export function pushDivider(dock: DockPlacement, path: SplitPath, ratio: number, space: DockSpace): DividerResult {
  const px = wholePixels(space);
  const box = gutterAt(layoutDock(dock.root, px.area, px.gap), path);
  if (!box || Number.isNaN(ratio)) return { dock, clamped: false };
  const range = leadRange(box, px);
  if (!range) return { dock, clamped: true };
  const dir = box.node.dir;
  const along = alongOf(dir, box.bounds);
  const wanted = leadLength(ratio, along, px.gap);
  const lead = Math.max(range.min, Math.min(range.max, wanted));
  const clamped = lead !== wanted;
  const current = leadLength(box.node.ratio, along, px.gap);
  if (lead === current) return { dock, clamped };
  const currentSecond = along - current - Math.min(px.gap, along - current);
  const nextSecond = along - lead - px.gap;
  const next = updateSplit(dock.root, path, (split) => ({
    ...split,
    ratio: ratioForLead(lead, along, px.gap),
    first: shrinkNode(split.first, current, lead, dir, px),
    second: shrinkNode(split.second, currentSecond, nextSecond, dir, px),
  }));
  return { dock: { ...dock, root: next }, clamped };
}

export function applyPreset(dock: DockPlacement, path: SplitPath, preset: SharePreset, space: DockSpace): DividerResult {
  const px = wholePixels(space);
  const box = gutterAt(layoutDock(dock.root, px.area, px.gap), path);
  const target = presetLead(dock, path, space, preset);
  if (!box || !target) return { dock, clamped: true };
  const moved = pushDivider(dock, path, ratioForLead(target.lead, alongOf(box.node.dir, box.bounds), px.gap), space);
  return { dock: moved.dock, clamped: target.clamped };
}
