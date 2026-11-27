import { formatPercent } from "../lib/format";
import type { ExtremeBasis } from "./settings";

export type ExtremeSide = "high" | "low";

export interface ExtremeTag {
  x: number;
  y: number;
  price: string;
  change: string | null;
}

export function extremeChange(price: number, last: number, basis: ExtremeBasis): string | null {
  const [from, to] = basis === "last" ? [last, price] : [price, last];
  return from === 0 ? null : formatPercent((to - from) / from * 100);
}

const SIDE_LABEL: Record<ExtremeSide, string> = { high: "최고", low: "최저" };
const LABEL_HEIGHT_PX = 20;
const LABEL_CHROME_PX = 14;
const PANE_EDGE_PX = 8;
const WIDE_GLYPH_PX = 11;
const NARROW_GLYPH_PX = 6.8;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface ExtremeBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ExtremeSurface {
  readonly paneWidth: number;
  readonly paneHeight: number;
  readonly avoid: ExtremeBox | null;
  readonly obstacles?: readonly ExtremeBox[];
}

export interface LabelPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly overlap: number;
}

export function estimateLabelWidth(text: string): number {
  let width = LABEL_CHROME_PX;
  for (const glyph of text) width += (glyph.codePointAt(0) ?? 0) >= 0x1100 ? WIDE_GLYPH_PX : NARROW_GLYPH_PX;
  return width;
}

function overlapArea(first: ExtremeBox, second: ExtremeBox): number {
  const xOverlap = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const yOverlap = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  return xOverlap * yOverlap;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function candidateOffsets(side: ExtremeSide, width: number, height: number): readonly (readonly [number, number])[] {
  if (side === "high") {
    return [
      [12, -height - 10],
      [-width - 12, -height - 10],
      [-width / 2, -height - 12],
      [16, -height / 2],
      [-width - 16, -height / 2],
      [22, -height - 16],
      [-width - 22, -height - 16],
      [12, 10],
      [-width - 12, 10],
      [-width / 2, 12],
    ];
  }
  return [
    [12, 10],
    [-width - 12, 10],
    [-width / 2, 12],
    [16, -height / 2],
    [-width - 16, -height / 2],
    [22, 16],
    [-width - 22, 16],
    [12, -height - 10],
    [-width - 12, -height - 10],
    [-width / 2, -height - 12],
  ];
}

export function placeExtremeLabel(
  side: ExtremeSide,
  tag: Pick<ExtremeTag, "x" | "y">,
  text: string,
  surface: ExtremeSurface,
  otherBox: ExtremeBox | null = null,
): LabelPlacement {
  const width = estimateLabelWidth(text);
  const height = LABEL_HEIGHT_PX;
  const maxLeft = Math.max(PANE_EDGE_PX, surface.paneWidth - PANE_EDGE_PX - width);
  const maxTop = Math.max(PANE_EDGE_PX, surface.paneHeight - PANE_EDGE_PX - height);
  const obstacles = surface.obstacles ?? [];
  const offsets = candidateOffsets(side, width, height);

  let best: { left: number; top: number; overlap: number; score: number } | null = null;
  for (let index = 0; index < offsets.length; index++) {
    const [dx, dy] = offsets[index]!;
    const absLeft = clamp(tag.x + dx, PANE_EDGE_PX, maxLeft);
    const absTop = clamp(tag.y + dy, PANE_EDGE_PX, maxTop);
    const box: ExtremeBox = { left: absLeft, top: absTop, right: absLeft + width, bottom: absTop + height };

    let obstacleOverlap = 0;
    for (let i = 0; i < obstacles.length; i++) obstacleOverlap += overlapArea(box, obstacles[i]!);
    const legendOverlap = surface.avoid === null ? 0 : overlapArea(box, surface.avoid);
    const otherOverlap = otherBox === null ? 0 : overlapArea(box, otherBox);
    const totalOverlap = obstacleOverlap + legendOverlap + otherOverlap;
    const score = obstacleOverlap * 10 + legendOverlap * 20 + otherOverlap * 30 + index * 1.5;

    if (best === null || score < best.score) {
      best = { left: absLeft - tag.x, top: absTop - tag.y, overlap: totalOverlap, score };
    }
    if (totalOverlap === 0) break;
  }

  const chosen = best!;
  const anchorX = clamp(0, chosen.left, chosen.left + width);
  const anchorY = clamp(0, chosen.top, chosen.top + height);
  return {
    left: chosen.left,
    top: chosen.top,
    width,
    height,
    anchorX,
    anchorY,
    overlap: chosen.overlap,
  };
}

class Tag {
  readonly root = document.createElement("div");
  private readonly line = document.createElementNS(SVG_NS, "line");
  private readonly price = document.createElement("span");
  private readonly label = document.createElement("span");
  private lastHidden = true;
  private lastTransform = "";
  private lastLabelTransform = "";
  private lastAnchor = "";

  constructor(private readonly side: ExtremeSide) {
    this.root.className = "chart-extreme";
    this.root.dataset.extreme = side;
    this.root.hidden = true;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "chart-extreme-line");
    svg.setAttribute("aria-hidden", "true");
    this.line.setAttribute("x1", "0");
    this.line.setAttribute("y1", "0");
    svg.append(this.line);
    const dot = document.createElement("i");
    const name = document.createElement("b");
    name.textContent = SIDE_LABEL[side];
    this.label.append(name, " ", this.price);
    this.root.append(svg, dot, this.label);
  }

  show(tag: ExtremeTag | null, surface: ExtremeSurface, otherBox: ExtremeBox | null): ExtremeBox | null {
    const hidden = tag === null;
    if (this.lastHidden !== hidden) {
      this.lastHidden = hidden;
      this.root.hidden = hidden;
    }
    if (!tag) return null;
    const transform = `translate(${tag.x}px, ${tag.y}px)`;
    if (this.lastTransform !== transform) {
      this.lastTransform = transform;
      this.root.style.transform = transform;
    }
    const text = tag.change === null ? tag.price : `${tag.price} (${tag.change})`;
    if (this.price.textContent !== text) this.price.textContent = text;
    const placement = placeExtremeLabel(this.side, tag, `${SIDE_LABEL[this.side]} ${text}`, surface, otherBox);
    const labelTransform = `translate(${Math.round(placement.left)}px, ${Math.round(placement.top)}px)`;
    if (this.lastLabelTransform !== labelTransform) {
      this.lastLabelTransform = labelTransform;
      this.label.style.transform = labelTransform;
    }
    const anchor = `${Math.round(placement.anchorX)},${Math.round(placement.anchorY)}`;
    if (this.lastAnchor !== anchor) {
      this.lastAnchor = anchor;
      this.line.setAttribute("x2", String(Math.round(placement.anchorX)));
      this.line.setAttribute("y2", String(Math.round(placement.anchorY)));
    }
    return {
      left: tag.x + placement.left,
      top: tag.y + placement.top,
      right: tag.x + placement.left + placement.width,
      bottom: tag.y + placement.top + placement.height,
    };
  }
}

export class ExtremeTags {
  private readonly high = new Tag("high");
  private readonly low = new Tag("low");

  constructor(parent: HTMLElement) {
    parent.append(this.high.root, this.low.root);
  }

  show(tags: Record<ExtremeSide, ExtremeTag | null> | null, surface: ExtremeSurface): void {
    const highBox = this.high.show(tags?.high ?? null, surface, null);
    this.low.show(tags?.low ?? null, surface, highBox);
  }

  dispose(): void {
    this.high.root.remove();
    this.low.root.remove();
  }
}
