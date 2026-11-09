import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = process.argv[2];
const require = createRequire(join(webDir, "package.json"));
const { chromium } = require("@playwright/test");
const lwcPath = join(webDir, "node_modules", "lightweight-charts", "dist", "lightweight-charts.standalone.production.js");

const browser = await chromium.launch({ chromiumSandbox: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
await page.setContent(readFileSync(join(here, "probe.html"), "utf8"));
await page.addScriptTag({ path: lwcPath });
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const results = {};

await page.evaluate(() => probe.setup());
await frame();
results.fractional = await page.evaluate(() => {
  const ts = chart.timeScale();
  const v = ts.logicalToCoordinate(250.25);
  return { value: v, type: typeof v, isNull: v === null, int250: ts.logicalToCoordinate(250), int251: ts.logicalToCoordinate(251) };
});

const sample = () => page.evaluate(() => {
  const canvases = [...document.querySelectorAll("#c canvas")];
  const out = document.createElement("canvas"); out.width = 900; out.height = 500;
  const ctx = out.getContext("2d");
  const root = document.getElementById("c").getBoundingClientRect();
  for (const c of canvases) { const r = c.getBoundingClientRect(); ctx.drawImage(c, r.left - root.left, r.top - root.top, r.width, r.height); }
  const d = ctx.getImageData(Math.round(candleXY.x), Math.round(candleXY.y), 1, 1).data;
  return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
});
for (const z of [null, "bottom", "normal", "top"]) {
  await page.evaluate((z) => {
    probe.setup();
    chart.applyOptions({ crosshair: { mode: window.LightweightCharts.CrosshairMode.Hidden }, timeScale: { barSpacing: 30 } });
    series.applyOptions({ upColor: "rgb(0,255,0)", downColor: "rgb(0,255,0)", wickUpColor: "rgb(0,255,0)", wickDownColor: "rgb(0,255,0)", borderVisible: false });
    series.setData(bars.map((b) => ({ ...b, open: 100, close: 110, high: 112, low: 98 })));
    window.boxPrim = z ? probe.addLines([], { zOrder: z }) : null;
  }, z);
  await frame();
  await page.evaluate(() => {
    const x = chart.timeScale().logicalToCoordinate(295), y = series.priceToCoordinate(105);
    window.candleXY = { x, y };
    if (boxPrim) { boxPrim.opts.box = { x: x - 40, y: y - 20, w: 80, h: 40 }; boxPrim.requestUpdate(); }
  });
  await frame();
  results[`candleCenter_${z ?? "noPrimitive"}`] = { at: await page.evaluate(() => candleXY), color: await sample() };
}
await browser.close();
writeFileSync(join(here, "results3.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
