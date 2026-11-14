import { CandlestickSeries, createChart } from "lightweight-charts";
import { DrawingLayer, paintShape } from "../src/chart/drawings/DrawingLayer";
import type { RenderFrame } from "../src/chart/drawings/frame";
import { hitShape, idsInBox, shapeBounds } from "../src/chart/drawings/geometry";
import { textLayout } from "../src/chart/drawings/textLayout";
import type { Shape, ToolContext } from "../src/chart/drawings/toolSpec";
import type { DrawingBody } from "../src/chart/drawings/types";

const pane = { width: 800, height: 400 };
const ctx: ToolContext = { toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }), xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n, barsIn: () => [], period: "D", fineBarsIn: () => ({ kind: "loading" }), barsBetween: () => null, paneWidth: 800, paneHeight: 400, formatPrice: String, formatTime: String, logScale: false };

function frame(shapes: readonly Shape[]): RenderFrame {
  const drawing: DrawingBody = { id: "text", symbol: "IDX:001", tool: "hline", points: [{ t: 100, price: 100 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
  return { items: [{ drawing, id: drawing.id, z: 1, shapes, handles: [], handleSpecs: [], labels: [] }], preview: shapes, transient: { shapes, opacity: 0.5 }, box: null, pane, ctx, editable: true };
}

export function layoutControls() {
  const canvas = document.createElement("canvas"); canvas.width = pane.width; canvas.height = pane.height; document.body.append(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context unavailable");
  const raw: Extract<Shape, { kind: "text" }> = { kind: "text", at: { x: 300, y: 260 }, text: "MMMMMMMM\njf", style: { color: "#000", size: 28, bold: true, italic: true }, align: "right", baseline: "bottom", box: { padding: 9, wrapWidth: 100 } };
  const inputs: Extract<Shape, { kind: "text" }>[] = [raw, { ...raw, orientation: "vertical", align: "center", baseline: "middle" }, { ...raw, text: "jf", align: "left", baseline: "top", box: undefined }];
  return inputs.map((input) => {
    const layer = new DrawingLayer(() => frame([input]));
    const prepared = layer.current();
    return [prepared.items[0]?.shapes[0], prepared.preview[0], prepared.transient?.shapes[0]].map((shape) => {
      if (!shape || shape.kind !== "text") throw new Error("Prepared text unavailable");
      const bounds = shapeBounds(shape, pane);
      const layout = textLayout(shape, () => { throw new Error("Prepared text was measured twice"); });
      context.clearRect(0, 0, pane.width, pane.height);
      paintShape(context, shape, pane);
      const pixels = context.getImageData(0, 0, pane.width, pane.height).data;
      let ink = 0; let misses = 0; let outsideBounds = 0;
      for (let y = 0; y < pane.height; y++) for (let x = 0; x < pane.width; x++) {
        if ((pixels[(y * pane.width + x) * 4 + 3] ?? 0) < 128) continue;
        ink++;
        const point = { x: x + 0.5, y: y + 0.5 };
        if (hitShape(shape, point, pane) !== "fill") misses++;
        if (point.x < bounds.x1 || point.x > bounds.x2 || point.y < bounds.y1 || point.y > bounds.y2) outsideBounds++;
      }
      const paddingPoint = input.orientation === "vertical"
        ? { x: input.at.x + layout.box.y1 + 2, y: input.at.y - layout.box.x1 - 2 }
        : { x: input.at.x + layout.box.x1 + 2, y: input.at.y + layout.box.y1 + 2 };
      return { vertical: input.orientation === "vertical", wrapped: !!input.box?.wrapWidth, overhang: layout.bounds.x1 < layout.box.x1 || layout.bounds.x2 > layout.box.x2, lines: layout.lines.map((line) => line.text), ink, misses, outsideBounds, bounds,
        paddingHit: hitShape(shape, paddingPoint, pane), selected: idsInBox([{ id: "text", z: 1, shapes: [shape], handles: [] }], paddingPoint, { x: paddingPoint.x + 1, y: paddingPoint.y + 1 }, pane) };
    });
  });
}

export async function fontRefreshControl() {
  const raw: Shape = { kind: "text", at: { x: 300, y: 200 }, text: "MMMMMMMM", style: { color: "#000", size: 28, bold: false, italic: false }, align: "right", baseline: "bottom" };
  let builds = 0;
  const layer = new DrawingLayer(() => { builds++; return frame([raw]); });
  const host = document.createElement("div"); document.body.append(host);
  const chart = createChart(host, { width: 800, height: 400 });
  const series = chart.addSeries(CandlestickSeries);
  series.attachPrimitive(layer);
  await document.fonts.ready;
  await Promise.resolve();
  const afterReady = builds;
  document.fonts.dispatchEvent(new Event("loadingdone"));
  const afterLoad = builds;
  series.detachPrimitive(layer);
  document.fonts.dispatchEvent(new Event("loadingdone"));
  const afterDetach = builds;
  chart.remove(); host.remove();
  return { afterReady, afterLoad, afterDetach };
}
