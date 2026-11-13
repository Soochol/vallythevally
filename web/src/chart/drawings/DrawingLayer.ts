import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView, IPanePrimitive, PrimitiveHoveredItem, SeriesAttachedParameter } from "lightweight-charts";
import { frameHit, type RenderFrame } from "./frame";
import { extendedSegment, HANDLE_DIAMETER_PX } from "./geometry";
import { prepareText, textFont, textLayout, type TextMeasure } from "./textLayout";
import type { Shape } from "./toolSpec";
import type { Fill, ScreenPoint, Stroke } from "./types";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];
const dash = { solid: [], dashed: [7, 5], dotted: [2, 4] };

export function drawingColor(color: string): string {
  return color.startsWith("$") ? getComputedStyle(document.documentElement).getPropertyValue(`--${color.slice(1)}`).trim() || "#12b5a5" : color;
}
function stroke(c: CanvasRenderingContext2D, s: Stroke | undefined) {
  if (!s) return;
  c.strokeStyle = drawingColor(s.color); c.lineWidth = s.width; c.setLineDash(dash[s.dash]); c.stroke();
}
function fill(c: CanvasRenderingContext2D, f: Fill | undefined) {
  if (!f?.on) return;
  c.save(); c.globalAlpha = f.opacity; c.fillStyle = drawingColor(f.color); c.fill(); c.restore();
}
function arrow(c: CanvasRenderingContext2D, from: ScreenPoint, to: ScreenPoint, s: Stroke) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x); const size = 7 + s.width;
  c.beginPath(); c.moveTo(to.x - size * Math.cos(angle - 0.45), to.y - size * Math.sin(angle - 0.45));
  c.lineTo(to.x, to.y); c.lineTo(to.x - size * Math.cos(angle + 0.45), to.y - size * Math.sin(angle + 0.45)); stroke(c, { ...s, dash: "solid" });
}

function canvasTextMeasure(c: CanvasRenderingContext2D): TextMeasure {
  return (text, style) => {
    c.font = textFont(style); c.textAlign = "left"; c.textBaseline = "top";
    const m = c.measureText(text);
    return { width: m.width, height: style.size * 1.2, ink: { x1: -m.actualBoundingBoxLeft, y1: -m.actualBoundingBoxAscent, x2: m.actualBoundingBoxRight, y2: m.actualBoundingBoxDescent } };
  };
}

export function paintShape(c: CanvasRenderingContext2D, s: Shape, pane: { width: number; height: number }) {
  c.save(); c.beginPath();
  switch (s.kind) {
    case "segment": {
      const { a, b } = extendedSegment(s.a, s.b, s.extend ?? "none", pane);
      c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); stroke(c, s.stroke);
      if (s.ends?.left === "arrow") arrow(c, s.b, s.a, s.stroke);
      if (s.ends?.right === "arrow") arrow(c, s.a, s.b, s.stroke);
      break;
    }
    case "polyline":
      s.points.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
      if (s.closed) c.closePath(); fill(c, s.fill); stroke(c, s.stroke); break;
    case "rect": {
      const x1 = s.extend === "left" || s.extend === "both" ? 0 : Math.min(s.a.x, s.b.x);
      const x2 = s.extend === "right" || s.extend === "both" ? pane.width : Math.max(s.a.x, s.b.x);
      c.rect(x1, Math.min(s.a.y, s.b.y), x2 - x1, Math.abs(s.b.y - s.a.y)); fill(c, s.fill); stroke(c, s.stroke); break;
    }
    case "ellipse":
      c.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2, Math.abs(s.b.y - s.a.y) / 2, 0, 0, Math.PI * 2); fill(c, s.fill); stroke(c, s.stroke); break;
    case "circle": c.arc(s.c.x, s.c.y, s.r, 0, Math.PI * 2); fill(c, s.fill); stroke(c, s.stroke); break;
    case "hband": c.rect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1); fill(c, s.fill); break;
    case "vline": c.moveTo(s.x, 0); c.lineTo(s.x, pane.height); stroke(c, s.stroke); break;
    case "text": {
      const layout = textLayout(s, canvasTextMeasure(c)); c.font = layout.font;
      c.translate(s.at.x, s.at.y); if (s.orientation === "vertical") c.rotate(-Math.PI / 2);
      const b = layout.box;
      c.beginPath(); c.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1); fill(c, s.box?.background); stroke(c, s.box?.border);
      c.fillStyle = drawingColor(s.style.color); c.textAlign = "left"; c.textBaseline = "top";
      for (const line of layout.lines) c.fillText(line.text, line.x, line.y);
      break;
    }
  }
  c.restore();
}

export class DrawingLayer implements ISeriesPrimitive {
  private frame: RenderFrame;
  private requestUpdate: (() => void) | null = null;
  private prices: ISeriesPrimitiveAxisView[] = [];
  private times: ISeriesPrimitiveAxisView[] = [];
  private readonly views: readonly IPrimitivePaneView[];
  private readonly measure: TextMeasure;
  private readonly fontsLoaded = () => this.refresh();
  private attachment = 0;

  constructor(private build: () => RenderFrame) {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Drawing text canvas unavailable");
    this.measure = canvasTextMeasure(context);
    this.frame = this.prepare(build());
    this.views = [{ zOrder: () => "normal", renderer: () => ({ draw: (target: Target) => this.draw(target) }) }];
  }
  attached(p: SeriesAttachedParameter) {
    this.requestUpdate = p.requestUpdate;
    const attachment = ++this.attachment;
    document.fonts.addEventListener("loadingdone", this.fontsLoaded);
    void document.fonts.ready.then(() => { if (this.attachment === attachment) this.refresh(); });
    this.refresh();
  }
  detached() { this.attachment++; document.fonts.removeEventListener("loadingdone", this.fontsLoaded); this.requestUpdate = null; }
  refresh() { this.updateAllViews(); this.requestUpdate?.(); }
  current() { return this.frame; }
  paneViews() { return this.views; }
  priceAxisViews() { return this.prices; }
  timeAxisViews() { return this.times; }

  private prepare(frame: RenderFrame): RenderFrame {
    const shape = (s: Shape) => s.kind === "text" ? prepareText(s, this.measure) : s;
    return { ...frame, items: frame.items.map((item) => ({ ...item, shapes: item.shapes.map(shape) })), preview: frame.preview.map(shape),
      transient: frame.transient ? { ...frame.transient, shapes: frame.transient.shapes.map(shape) } : undefined };
  }

  updateAllViews() {
    this.frame = this.prepare(this.build()); this.prices = []; this.times = [];
    for (const item of this.frame.items) for (const label of item.labels) {
      const coordinate = label.axis === "price" ? this.frame.ctx.yOf(label.value) : this.frame.ctx.xOf(label.value);
      if (coordinate === null) continue;
      const max = label.axis === "price" ? this.frame.pane.height : this.frame.pane.width;
      const view: ISeriesPrimitiveAxisView = { coordinate: () => coordinate, text: () => label.text, textColor: () => "#ffffff", backColor: () => drawingColor(label.color), visible: () => coordinate >= 0 && coordinate <= max };
      (label.axis === "price" ? this.prices : this.times).push(view);
    }
  }
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const hit = frameHit(this.current(), { x, y });
    return hit.kind === "empty" ? null : { externalId: hit.id, zOrder: "normal", cursorStyle: hit.kind === "handle" ? "grab" : "move", hitTestPriority: hit.kind === "handle" ? 2 : hit.part === "line" ? 1 : 0 };
  }
  private draw(target: Target) {
    target.useMediaCoordinateSpace(({ context: c }) => {
      const f = this.frame;
      for (const item of f.items) {
        for (const s of item.shapes) paintShape(c, s, f.pane);
        for (const p of item.handles) {
          c.save(); c.beginPath(); c.arc(p.x, p.y, HANDLE_DIAMETER_PX / 2, 0, Math.PI * 2);
          c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--chart-bg"); c.fill();
          c.strokeStyle = drawingColor("$draw"); c.lineWidth = 1.5; c.stroke(); c.restore();
        }
      }
      for (const s of f.preview) paintShape(c, s, f.pane);
      if (f.transient) { c.save(); c.globalAlpha = f.transient.opacity; for (const s of f.transient.shapes) paintShape(c, s, f.pane); c.restore(); }
      if (f.box) {
        const { start: a, end: b } = f.box;
        paintShape(c, { kind: "rect", a, b, stroke: { color: "$draw", width: 1, dash: "dashed" }, fill: { on: true, color: "$draw", opacity: 0.08 } }, f.pane);
      }
    });
  }
}

export class VLinePaneLayer implements IPanePrimitive {
  constructor(private lines: () => readonly Extract<Shape, { kind: "vline" }>[], private height: () => number) {}
  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => "normal", renderer: () => ({ draw: (target: Target) => target.useMediaCoordinateSpace(({ context }) => {
      for (const s of this.lines()) if (s.allPanes) paintShape(context, s, { width: 0, height: this.height() });
    }) }) }];
  }
}
