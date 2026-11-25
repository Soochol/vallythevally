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
const FLIP_WITHIN_PX = 190;
const LABEL_ABOVE_PX = -30;
const LABEL_BELOW_PX = 10;
const LABEL_HEIGHT_PX = 20;
const LABEL_INSET_PX = 10;
const LABEL_CHROME_PX = 18;
const PANE_EDGE_PX = 8;
const WIDE_GLYPH_PX = 11;
const NARROW_GLYPH_PX = 6.8;

export interface ExtremeBox { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

export interface ExtremeSurface {
  readonly paneWidth: number;
  readonly paneHeight: number;
  readonly avoid: ExtremeBox | null;
}

export interface LabelPlacement {
  readonly flip: boolean;
  readonly top: number;
}

export function estimateLabelWidth(text: string): number {
  let width = LABEL_CHROME_PX;
  for (const glyph of text) width += (glyph.codePointAt(0) ?? 0) >= 0x1100 ? WIDE_GLYPH_PX : NARROW_GLYPH_PX;
  return width;
}

function intersects(first: ExtremeBox, second: ExtremeBox): boolean {
  return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
}

export function placeExtremeLabel(side: ExtremeSide, tag: Pick<ExtremeTag, "x" | "y">, text: string, surface: ExtremeSurface): LabelPlacement {
  const width = estimateLabelWidth(text);
  const edgeFlip = tag.x > surface.paneWidth - FLIP_WITHIN_PX;
  const preferred = side === "high" ? LABEL_ABOVE_PX : LABEL_BELOW_PX;
  const opposite = side === "high" ? LABEL_BELOW_PX : LABEL_ABOVE_PX;
  const lowest = surface.paneHeight - PANE_EDGE_PX - LABEL_HEIGHT_PX;
  const candidates = [[edgeFlip, preferred], [edgeFlip, opposite], [!edgeFlip, preferred], [!edgeFlip, opposite]] as const;
  const placed = candidates.map(([flip, offset]) => {
    const top = Math.max(PANE_EDGE_PX, Math.min(lowest, tag.y + offset)) - tag.y;
    const left = flip ? tag.x + LABEL_INSET_PX - width : tag.x - LABEL_INSET_PX;
    const box = { left, right: left + width, top: tag.y + top, bottom: tag.y + top + LABEL_HEIGHT_PX };
    return { flip, top, clear: surface.avoid === null || !intersects(box, surface.avoid) };
  });
  const chosen = placed.find((candidate) => candidate.clear) ?? placed[0]!;
  return { flip: chosen.flip, top: chosen.top };
}

class Tag {
  readonly root = document.createElement("div");
  private readonly price = document.createElement("span");
  private readonly label = document.createElement("span");
  private placed: LabelPlacement | null = null;
  private lastHidden = true;
  private lastTransform = "";

  constructor(private readonly side: ExtremeSide) {
    this.root.className = "chart-extreme";
    this.root.dataset.extreme = side;
    this.root.hidden = true;
    const dot = document.createElement("i");
    const name = document.createElement("b");
    name.textContent = SIDE_LABEL[side];
    this.label.append(name, " ", this.price);
    this.root.append(dot, this.label);
  }

  show(tag: ExtremeTag | null, surface: ExtremeSurface): void {
    const hidden = tag === null;
    if (this.lastHidden !== hidden) {
      this.lastHidden = hidden;
      this.root.hidden = hidden;
    }
    if (!tag) return;
    const transform = `translate(${tag.x}px, ${tag.y}px)`;
    if (this.lastTransform !== transform) {
      this.lastTransform = transform;
      this.root.style.transform = transform;
    }
    const text = tag.change === null ? tag.price : `${tag.price} (${tag.change})`;
    if (this.price.textContent !== text) this.price.textContent = text;
    const placement = placeExtremeLabel(this.side, tag, `${SIDE_LABEL[this.side]} ${text}`, surface);
    if (this.placed?.flip !== placement.flip) this.root.toggleAttribute("data-flip", placement.flip);
    if (this.placed?.top !== placement.top) this.label.style.top = `${placement.top}px`;
    this.placed = placement;
  }
}

export class ExtremeTags {
  private readonly high = new Tag("high");
  private readonly low = new Tag("low");

  constructor(parent: HTMLElement) {
    parent.append(this.high.root, this.low.root);
  }

  show(tags: Record<ExtremeSide, ExtremeTag | null> | null, surface: ExtremeSurface): void {
    this.high.show(tags?.high ?? null, surface);
    this.low.show(tags?.low ?? null, surface);
  }

  dispose(): void {
    this.high.root.remove();
    this.low.root.remove();
  }
}
