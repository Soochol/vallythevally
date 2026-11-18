import type { DockPlacement } from "../placement";
import { alongOf, gutterAt, leadRange, type LeadRange } from "./axis";
import { WIDE_SHARE } from "./fit";
import { layoutDock, leadLength, wholePixels, type DockSpace } from "./geometry";
import { SPLIT_SHARE } from "./split";
import type { SplitPath } from "./tree";

export type StopKind = "ratio" | "default" | "align";
export type Stop = { kind: StopKind; lead: number; guide: number };

export const SNAP_DISTANCE = 8;

const RATIO_SHARES = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
const KIND_RANK: Record<StopKind, number> = { align: 0, default: 1, ratio: 2 };

export function dividerStops(dock: DockPlacement, path: SplitPath, space: DockSpace): Stop[] {
  const px = wholePixels(space);
  const layout = layoutDock(dock.root, px.area, px.gap);
  const box = gutterAt(layout, path);
  const range = box && leadRange(box, px);
  if (!box || !range) return [];
  const dir = box.node.dir;
  const along = alongOf(dir, box.bounds);
  const origin = dir === "row" ? box.bounds.x : box.bounds.y;
  const shared = (share: number) => leadLength(share, along, px.gap);
  const found: Omit<Stop, "guide">[] = [
    ...RATIO_SHARES.map((share) => ({ kind: "ratio" as const, lead: shared(share) })),
    ...(dir === "row" ? [{ kind: "default" as const, lead: shared(WIDE_SHARE) }] : []),
    ...layout.gutters
      .filter((other) => other.node.dir === dir && other.path.join() !== path.join())
      .map((other) => ({ kind: "align" as const, lead: (dir === "row" ? other.rect.x : other.rect.y) - origin })),
  ];
  const byLead = new Map<number, Omit<Stop, "guide">>();
  for (const stop of found) {
    if (stop.lead < range.min || stop.lead > range.max) continue;
    const kept = byLead.get(stop.lead);
    if (!kept || KIND_RANK[stop.kind] < KIND_RANK[kept.kind]) byLead.set(stop.lead, stop);
  }
  return [...byLead.values()].map((stop) => ({ ...stop, guide: origin + stop.lead })).sort((a, b) => a.lead - b.lead);
}

export type Snapped = { lead: number; stop: Stop | null };

export function snapLead(lead: number, stops: readonly Stop[], distance: number = SNAP_DISTANCE): Snapped {
  let near: Stop | null = null;
  for (const stop of stops) {
    const gap = Math.abs(stop.lead - lead);
    if (gap > distance) continue;
    const nearGap = near ? Math.abs(near.lead - lead) : Infinity;
    if (gap < nearGap || (gap === nearGap && near && stop.lead < near.lead)) near = stop;
  }
  return near ? { lead: near.lead, stop: near } : { lead, stop: null };
}

export function nextStop(lead: number, stops: readonly Stop[], direction: 1 | -1): Stop | null {
  const ahead = stops.filter((stop) => (direction === 1 ? stop.lead > lead : stop.lead < lead));
  return ahead.reduce<Stop | null>((near, stop) => (near && Math.abs(near.lead - lead) <= Math.abs(stop.lead - lead) ? near : stop), null);
}

export type SharePreset = "half" | "one-two" | "two-one" | "default";

export type PresetLead = { lead: number; clamped: boolean };

export function presetLead(dock: DockPlacement, path: SplitPath, space: DockSpace, preset: SharePreset): PresetLead | null {
  const px = wholePixels(space);
  const box = gutterAt(layoutDock(dock.root, px.area, px.gap), path);
  const range: LeadRange | null = box ? leadRange(box, px) : null;
  if (!box || !range) return null;
  const share = { half: 1 / 2, "one-two": 1 / 3, "two-one": 2 / 3, default: box.node.dir === "row" ? WIDE_SHARE : SPLIT_SHARE }[preset];
  const wanted = leadLength(share, alongOf(box.node.dir, box.bounds), px.gap);
  const lead = Math.max(range.min, Math.min(range.max, wanted));
  return { lead, clamped: lead !== wanted };
}
