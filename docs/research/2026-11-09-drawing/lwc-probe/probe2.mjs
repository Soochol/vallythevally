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
results.coords = await page.evaluate(() => {
  const ts = chart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  const probeL = [200, 200.5, 250.25, 299, 299.5, 304, 304.5, 120, 120.5];
  const x = Object.fromEntries(probeL.map((l) => [l, ts.logicalToCoordinate(l)]));
  const xs = [100.3, 500.7, 870.2];
  const back = Object.fromEntries(xs.map((v) => [v, ts.coordinateToLogical(v)]));
  return { visibleRange: vr, barSpacing: ts.options().barSpacing, logicalToCoordinate: x, coordinateToLogical: back };
});

for (const z of ["normal", "bottom", "top"]) {
  await page.evaluate((z) => {
    probe.setup();
    chart.applyOptions({ crosshair: { mode: window.LightweightCharts.CrosshairMode.Hidden } });
    series.applyOptions({ upColor: "rgb(0,255,0)", downColor: "rgb(0,255,0)", wickUpColor: "rgb(0,255,0)", wickDownColor: "rgb(0,255,0)", borderVisible: false });
    const ts = chart.timeScale();
    const bar = bars[250];
    const x = ts.logicalToCoordinate(250), y = series.priceToCoordinate((bar.open + bar.close) / 2);
    window.candleXY = { x, y };
    probe.addLines([], { zOrder: z, box: { x: x - 20, y: y - 20, w: 40, h: 40 } });
  }, z);
  await frame();
  results[`overCandle_${z}`] = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll("#c canvas")];
    const out = document.createElement("canvas"); out.width = 900; out.height = 500;
    const ctx = out.getContext("2d");
    const root = document.getElementById("c").getBoundingClientRect();
    for (const c of canvases) { const r = c.getBoundingClientRect(); ctx.drawImage(c, r.left - root.left, r.top - root.top, r.width, r.height); }
    const d = ctx.getImageData(Math.round(candleXY.x), Math.round(candleXY.y), 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  });
}

async function perf(mode, n) {
  await page.evaluate(([mode, n]) => {
    probe.setup({ bars: 2000 });
    const mk = (i) => ({ id: `d${i}`, l1: 1000 + (i * 7) % 900, p1: 80 + (i % 40), l2: 1000 + (i * 7) % 900 + 60, p2: 85 + (i % 37) });
    window.prims = [];
    if (mode === "one") window.prims.push(probe.addLines(Array.from({ length: n }, (_, i) => mk(i))));
    else for (let i = 0; i < n; i++) window.prims.push(probe.addLines([mk(i)]));
    chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1999 });
  }, [mode, n]);
  await frame();
  return page.evaluate(([mode, n]) => new Promise((resolve) => {
    const ts = chart.timeScale();
    prims.forEach((p) => { p.drawMs = 0; p.draws = 0; p.updateMs = 0; });
    const busy = []; let i = 0;
    function step() {
      if (i++ >= 120) {
        busy.sort((a, b) => a - b);
        const draws = prims.reduce((a, p) => a + p.draws, 0);
        resolve({ mode, n, frames: busy.length, scrollCallP50ms: busy[Math.floor(busy.length / 2)], scrollCallP95ms: busy[Math.floor(busy.length * 0.95)],
          primitiveDrawMsPerFrame: prims.reduce((a, p) => a + p.drawMs, 0) / 120, primitiveUpdateMsPerFrame: prims.reduce((a, p) => a + p.updateMs, 0) / 120, drawCalls: draws });
        return;
      }
      const t0 = performance.now();
      ts.scrollToPosition(-(i * 3), false);
      busy.push(performance.now() - t0);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }), [mode, n]);
}
results.perf = [];
for (const n of [100, 500, 2000]) for (const mode of ["one", "many"]) results.perf.push(await perf(mode, n));

await page.evaluate(() => {
  probe.setup({ bars: 2000 });
  const mk = (i) => ({ id: `d${i}`, l1: 1000 + (i * 7) % 900, p1: 80 + (i % 40), l2: 1000 + (i * 7) % 900 + 60, p2: 85 + (i % 37) });
  window.prims = [probe.addLines(Array.from({ length: 500 }, (_, i) => mk(i)))];
  chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1999 });
});
await frame();
results.wholeFrame500 = await page.evaluate(() => new Promise((resolve) => {
  const ts = chart.timeScale(); const total = []; let i = 0;
  function step() {
    if (i++ >= 60) { total.sort((a, b) => a - b); resolve({ note: "scroll + forced layout read per frame", p50: total[30], p95: total[57] }); return; }
    const t0 = performance.now();
    ts.scrollToPosition(-(i * 3), false);
    prims[0].requestUpdate();
    document.querySelector("#c canvas").getContext("2d").getImageData(0, 0, 1, 1);
    total.push(performance.now() - t0);
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}));
await browser.close();
writeFileSync(join(here, "results2.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
