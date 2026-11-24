import type { WindowId } from "../kinds";
import type { DockNode, DockPlacement } from "../placement";
import { carryRatios } from "./carry";
import { dockMinSize, drawDock, leadLength, ratioForLead, tabsMinSize, wholePixels, type DockSpace } from "./geometry";

type Metrics = Pick<DockSpace, "gap" | "windows">;
type Column = { node: DockNode; width: number; wanted: number; parts: readonly [Column, Column] | null };

export type ColumnShift = { targets: ReadonlySet<WindowId>; change: number; before: DockSpace; after: DockSpace };

const limitedByMin = (wanted: number, width: number, least: number): number => Math.max(wanted, Math.min(0, least - width));

const smallerMove = (a: number, b: number): number => (a === 0 ? b : b === 0 || Math.abs(a) <= Math.abs(b) ? a : b);

function measureColumn(node: DockNode, width: number, shift: ColumnShift, metrics: Metrics): Column {
  if (node.kind === "group") {
    const wanted = node.tabs.some((tab) => shift.targets.has(tab)) ? limitedByMin(shift.change, width, tabsMinSize(metrics.windows, node.tabs).w) : 0;
    return { node, width, wanted, parts: null };
  }
  if (node.dir === "column") {
    const first = measureColumn(node.first, width, shift, metrics);
    const second = measureColumn(node.second, width, shift, metrics);
    const wanted = limitedByMin(smallerMove(first.wanted, second.wanted), width, dockMinSize(node, metrics).w);
    return { node, width, wanted, parts: [first, second] };
  }
  const lead = leadLength(node.ratio, width, metrics.gap);
  const first = measureColumn(node.first, lead, shift, metrics);
  const second = measureColumn(node.second, width - lead - Math.min(metrics.gap, width - lead), shift, metrics);
  return { node, width, wanted: first.wanted !== 0 && second.wanted !== 0 ? first.wanted + second.wanted : 0, parts: [first, second] };
}

function leadChange(first: Column, second: Column, change: number): number | null {
  if (first.wanted !== 0 && second.wanted !== 0) return Math.round((change * first.wanted) / (first.wanted + second.wanted));
  if (first.wanted !== 0) return first.wanted;
  if (second.wanted !== 0) return change - second.wanted;
  return null;
}

function resizeColumn(column: Column, change: number, metrics: Metrics): DockNode {
  const { node, width, parts } = column;
  if (node.kind === "group" || !parts) return node;
  const [first, second] = parts;
  if (node.dir === "column") return withParts(node, node.ratio, resizeColumn(first, change, metrics), resizeColumn(second, change, metrics));
  const along = width + change;
  const kept = leadLength(node.ratio, along, metrics.gap);
  const moved = leadChange(first, second, change);
  const least = dockMinSize(node.first, metrics).w;
  const most = along - metrics.gap - dockMinSize(node.second, metrics).w;
  const lead = moved === null || least > most ? kept : Math.max(least, Math.min(most, first.width + moved));
  const ratio = lead === kept ? node.ratio : ratioForLead(lead, along, metrics.gap);
  const rest = along - lead - Math.min(metrics.gap, along - lead);
  return withParts(node, ratio, resizeColumn(first, lead - first.width, metrics), resizeColumn(second, rest - second.width, metrics));
}

const withParts = (node: Extract<DockNode, { kind: "split" }>, ratio: number, first: DockNode, second: DockNode): DockNode =>
  ratio === node.ratio && first === node.first && second === node.second ? node : { ...node, ratio, first, second };

export function shiftColumns(dock: DockPlacement, shift: ColumnShift): DockPlacement {
  const px = wholePixels(shift.after);
  if (px.area.w <= 0 || px.area.h <= 0) return dock;
  const drawn = drawDock(dock, shift.before).dock;
  const root = resizeColumn(measureColumn(drawn.root, px.area.w, shift, px), 0, px);
  return root === drawn.root ? dock : carryRatios(dock, drawn, { ...drawn, root });
}

export function splitShape(node: DockNode): string {
  return node.kind === "group" ? node.id : `(${node.dir} ${node.ratio} ${splitShape(node.first)} ${splitShape(node.second)})`;
}
