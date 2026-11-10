import { DrawingLayer, paintShape } from "../src/chart/drawings/DrawingLayer";
import { hitShape, shapeBounds } from "../src/chart/drawings/geometry";
import { hline, hlineDefaults } from "../src/chart/drawings/tools/hline";
import type { ToolContext } from "../src/chart/drawings/toolSpec";

export function textProbe() {
  const canvas = document.createElement("canvas");
  canvas.width = 800; canvas.height = 400; document.body.append(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context unavailable");
  const ctx: ToolContext = { toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }), xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n, barsBetween: () => null, paneWidth: 800, paneHeight: 400, formatPrice: String, formatTime: String, logScale: false };
  const style = hlineDefaults();
  const rawLabel = hline.shapes({ points: [{ t: 650, price: 104 }], text: "MMMMMMMMMMMM", style: { ...style, label: { ...style.label, size: 28 } }, selected: false }, ctx).find((s) => s.kind === "text");
  if (!rawLabel) throw new Error("Hline label unavailable");
  rawLabel.at = { x: 650, y: 100 };
  const pane = { width: 800, height: 400 };
  const drawing = { id: "text-hit", symbol: "IDX:001", tool: "hline", points: [{ t: 650, price: 104 }], text: "MMMMMMMMMMMM", style, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 } as const;
  const layer = new DrawingLayer(() => ({ items: [{ drawing: { ...drawing, points: [...drawing.points] }, id: drawing.id, z: 1, shapes: [rawLabel], handles: [], handleSpecs: [], labels: [] }], preview: [], box: null, pane, ctx, editable: true }));
  const label = layer.current().items[0]?.shapes.find((s) => s.kind === "text");
  if (!label) throw new Error("Layer label unavailable");
  paintShape(context, label, pane);
  context.font = "28px Pretendard, sans-serif";
  const actualWidth = context.measureText(label.text).width;
  const at = { x: 650 - actualWidth + 10, y: 80 };
  const ink = [...context.getImageData(Math.floor(at.x) - 4, Math.floor(at.y) - 4, 9, 9).data].filter((n, i) => i % 4 === 3 && n > 0).length;
  return { actualWidth, at, ink, hit: hitShape(label, at, pane), bounds: shapeBounds(label, pane) };
}
