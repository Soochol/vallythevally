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

class Tag {
  readonly root = document.createElement("div");
  private readonly price = document.createElement("span");

  constructor(side: ExtremeSide) {
    this.root.className = "chart-extreme";
    this.root.dataset.extreme = side;
    this.root.hidden = true;
    const dot = document.createElement("i");
    const label = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = SIDE_LABEL[side];
    label.append(name, " ", this.price);
    this.root.append(dot, label);
  }

  show(tag: ExtremeTag | null, paneWidth: number): void {
    this.root.hidden = tag === null;
    if (!tag) return;
    this.root.style.transform = `translate(${tag.x}px, ${tag.y}px)`;
    this.root.toggleAttribute("data-flip", tag.x > paneWidth - FLIP_WITHIN_PX);
    this.price.textContent = tag.change === null ? tag.price : `${tag.price} (${tag.change})`;
  }
}

export class ExtremeTags {
  private readonly high = new Tag("high");
  private readonly low = new Tag("low");

  constructor(parent: HTMLElement) {
    parent.append(this.high.root, this.low.root);
  }

  show(tags: Record<ExtremeSide, ExtremeTag | null> | null, paneWidth: number): void {
    this.high.show(tags?.high ?? null, paneWidth);
    this.low.show(tags?.low ?? null, paneWidth);
  }

  dispose(): void {
    this.high.root.remove();
    this.low.root.remove();
  }
}
