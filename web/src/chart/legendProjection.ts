import { shapeSetOf, trackedValuesOf } from "./legendShapes";

export type LegendTier = "compact" | "minimal";

export interface LegendTierInput {
  readonly chartWidth: number;
  readonly paneHeight: number;
  readonly phone: boolean;
}

export const MINIMAL_BELOW_WIDTH = 320;
export const FOLD_ABOVE_ROWS = 3;
export const MIN_TOP_MARGIN = 0.08;
export const MAX_TOP_MARGIN = 0.6;
export const LEGEND_GAP_PX = 6;

export function legendTier({ chartWidth, phone }: LegendTierInput): LegendTier {
  if (phone || chartWidth < MINIMAL_BELOW_WIDTH) return "minimal";
  return "compact";
}

export function denserTier(tier: LegendTier): LegendTier | null {
  return tier === "compact" ? "minimal" : null;
}

export function indicatorRowsFolded(tier: LegendTier, rowCount: number, pinnedOpen: boolean): boolean {
  if (tier === "minimal") return rowCount > 0;
  return rowCount > FOLD_ABOVE_ROWS && !pinnedOpen;
}

export function priceTopMargin(legendBottom: number, paneHeight: number): number {
  if (!(paneHeight > 0)) return MIN_TOP_MARGIN;
  return Math.min(MAX_TOP_MARGIN, Math.max(MIN_TOP_MARGIN, (legendBottom + LEGEND_GAP_PX) / paneHeight));
}

export interface LegendField {
  element: HTMLElement;
  alternatives: readonly string[];
}

export interface LegendProjection {
  root: HTMLElement;
  fields: readonly LegendField[];
}

const PROBE_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function expandShapeDigits(shapes: Iterable<string>): string {
  const lines: string[] = [];
  for (const shape of shapes) {
    if (!shape.includes("0")) {
      lines.push(shape);
      continue;
    }
    for (const digit of PROBE_DIGITS) lines.push(shape.replaceAll("0", digit));
  }
  return lines.join("\n");
}

function probeShapes(alternatives: readonly string[]): string {
  const tracked = trackedValuesOf(alternatives);
  return expandShapeDigits(tracked ? tracked.uniqueShapes() : shapeSetOf(alternatives));
}

export function reserveLegendFields(fields: readonly LegendField[]): void {
  const styles = fields.map(({ element }) => getComputedStyle(element));
  const probes = fields.map(({ element, alternatives }, i) => {
    const probe = document.createElement("span");
    probe.textContent = probeShapes(alternatives);
    const style = styles[i];
    if (style) Object.assign(probe.style, { font: style.font, letterSpacing: style.letterSpacing, fontFeatureSettings: style.fontFeatureSettings, fontVariantNumeric: style.fontVariantNumeric });
    Object.assign(probe.style, { position: "absolute", whiteSpace: "pre", width: "max-content", maxWidth: "none", height: "0px", overflow: "hidden" });
    element.append(probe);
    return probe;
  });
  const widths = probes.map((probe) => probe.getBoundingClientRect().width);
  fields.forEach(({ element, alternatives }, i) => {
    const style = styles[i];
    const chrome = style ? [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce((sum, value) => sum + parseFloat(value), 0) : 0;
    element.textContent = alternatives[0] ?? "";
    element.hidden = alternatives.length === 0;
    Object.assign(element.style, { display: alternatives.length ? "inline-block" : "none", width: `${(widths[i] ?? 0) + chrome}px`, flexShrink: "0" });
  });
}
