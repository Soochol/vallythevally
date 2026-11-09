import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = process.argv[2];
const require = createRequire(join(webDir, "package.json"));
const { chromium } = require("@playwright/test");
const lwcPath = join(webDir, "node_modules", "lightweight-charts", "dist", "lightweight-charts.standalone.production.js");
const lwcVersion = JSON.parse(readFileSync(join(dirname(lwcPath), "..", "package.json"), "utf8")).version;

const browser = await chromium.launch({ chromiumSandbox: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
await page.setContent(readFileSync(join(here, "probe.html"), "utf8"));
await page.addScriptTag({ path: lwcPath });
const results = { lwcVersion, date: new Date().toISOString() };
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const box = async () => page.locator("#c").boundingBox();

async function rgbAt(x, y) {
  return page.evaluate(async ([x, y]) => {
    const canvases = [...document.querySelectorAll("#c canvas")];
    const out = document.createElement("canvas");
    out.width = 900; out.height = 500;
    const ctx = out.getContext("2d");
    const root = document.getElementById("c").getBoundingClientRect();
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      ctx.drawImage(c, r.left - root.left, r.top - root.top, r.width, r.height);
    }
    const d = ctx.getImageData(x, y, 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  }, [x, y]);
}

await page.evaluate(() => {
  probe.setup();
  const ts = chart.timeScale();
  window.p1 = probe.addLines([{ id: "line-A", l1: 200, p1: 100, l2: 280, p2: 100 }]);
});
await frame();
const hit = await page.evaluate(() => {
  const ts = chart.timeScale();
  return { x: ts.logicalToCoordinate(240), y: series.priceToCoordinate(100) };
});
const b = await box();
await page.mouse.move(b.x + hit.x, b.y + hit.y + 3);
await frame();
const cursorOn = await page.evaluate(() => [...document.querySelectorAll("#c *")].map((e) => getComputedStyle(e).cursor).find((c) => c === "pointer") ?? null);
await page.mouse.click(b.x + hit.x, b.y + hit.y + 3);
await page.mouse.move(b.x + hit.x, b.y + hit.y + 60);
await frame();
await page.mouse.click(b.x + hit.x, b.y + hit.y + 60);
await frame();
results.hitTest = { cursorWhenOverLine: cursorOn, clicks: await page.evaluate(() => window.clicks) };

results.coords = await page.evaluate(() => {
  const ts = chart.timeScale();
  const x = ts.logicalToCoordinate(123.25);
  const back = ts.coordinateToLogical(x);
  const y = series.priceToCoordinate(101.37);
  const priceBack = series.coordinateToPrice(y);
  const lastLogical = bars.length - 1;
  const futureX = ts.logicalToCoordinate(lastLogical + 5.5);
  const futureBack = ts.coordinateToLogical(futureX);
  const lastX = ts.logicalToCoordinate(lastLogical);
  const timeOfFuture = ts.coordinateToTime(futureX);
  return { x, back, y, priceBack, lastLogical, lastX, futureX, futureBack, timeOfFuture, fractionalPreserved: Math.abs(back - 123.25) < 0.01 };
});

await page.evaluate(() => {
  window.dragLog = [];
  const el = document.getElementById("c");
  el.addEventListener("pointerdown", (e) => {
    const r = el.getBoundingClientRect();
    const hitRes = p1.hitTest(e.clientX - r.left, e.clientY - r.top);
    window.dragLog.push({ type: "down", hit: hitRes?.externalId ?? null });
    if (hitRes) chart.applyOptions({ handleScroll: false, handleScale: false });
  }, { capture: true });
  el.addEventListener("pointerup", () => { chart.applyOptions({ handleScroll: true, handleScale: true }); window.dragLog.push({ type: "up" }); }, { capture: true });
});
const rangeBefore = await page.evaluate(() => chart.timeScale().getVisibleLogicalRange());
await page.mouse.move(b.x + hit.x, b.y + hit.y + 2);
await page.mouse.down();
await page.mouse.move(b.x + hit.x - 150, b.y + hit.y + 2, { steps: 10 });
await page.mouse.up();
await frame();
const rangeAfterLineDrag = await page.evaluate(() => chart.timeScale().getVisibleLogicalRange());
await page.mouse.move(b.x + 300, b.y + 400);
await page.mouse.down();
await page.mouse.move(b.x + 150, b.y + 400, { steps: 10 });
await page.mouse.up();
await frame();
const rangeAfterEmptyDrag = await page.evaluate(() => chart.timeScale().getVisibleLogicalRange());
results.drag = { rangeBefore, rangeAfterLineDrag, rangeAfterEmptyDrag, log: await page.evaluate(() => window.dragLog),
  chartScrolledOnLineDrag: Math.abs(rangeBefore.from - rangeAfterLineDrag.from) > 0.01,
  chartScrolledOnEmptyDrag: Math.abs(rangeAfterLineDrag.from - rangeAfterEmptyDrag.from) > 0.01 };

for (const z of ["top", "normal", "bottom"]) {
  await page.evaluate((z) => {
    probe.setup();
    window.p2 = probe.addLines([], { zOrder: z, box: { x: 300, y: 150, w: 200, h: 150 } });
  }, z);
  await frame();
  await page.mouse.move(b.x + 400, b.y + 225);
  await frame();
  results[`zorder_${z}`] = { crosshairCenter: await rgbAt(400, 225), boxOnly: await rgbAt(320, 160) };
}
await page.evaluate(() => {
  probe.setup();
  const t = bars[150].time;
  window.p3 = probe.addLines([], { priceLabel: 100, timeLabel: t, autoscale: [10, 300] });
});
await frame();
results.axis = await page.evaluate(() => {
  const ps = series.priceScale();
  const h = 500 - 28;
  const top = series.coordinateToPrice(0), bottom = series.coordinateToPrice(h - 1);
  return { visiblePriceTop: top, visiblePriceBottom: bottom, autoscaleIncluded10to300: top >= 300 && bottom <= 10 };
});
await page.mouse.move(b.x + 5, b.y + 5);
await frame();
const shot = await page.screenshot({ clip: { x: b.x, y: b.y, width: 900, height: 500 } });
writeFileSync(join(here, "axis-labels.png"), shot);
results.axisPixels = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll("#c canvas")];
  const out = document.createElement("canvas"); out.width = 900; out.height = 500;
  const ctx = out.getContext("2d");
  const root = document.getElementById("c").getBoundingClientRect();
  for (const c of canvases) { const r = c.getBoundingClientRect(); ctx.drawImage(c, r.left - root.left, r.top - root.top, r.width, r.height); }
  const img = ctx.getImageData(0, 0, 900, 500).data;
  let magentaInPriceAxis = 0, greenInTimeAxis = 0;
  const priceAxisX = 900 - 40, timeAxisY = 500 - 12;
  for (let y = 0; y < 500; y++) { const i = (y * 900 + priceAxisX) * 4; if (img[i] > 240 && img[i + 1] < 20 && img[i + 2] > 240) magentaInPriceAxis++; }
  for (let x = 0; x < 900; x++) { const i = (timeAxisY * 900 + x) * 4; if (img[i] < 20 && img[i + 1] > 180 && img[i + 2] < 20) greenInTimeAxis++; }
  return { magentaInPriceAxis, greenInTimeAxis };
});

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
  const scroll = await page.evaluate(() => new Promise((resolve) => {
    const ts = chart.timeScale();
    const deltas = []; let last = null; let i = 0;
    function step(now) {
      if (last !== null) deltas.push(now - last);
      last = now;
      if (i++ >= 120) {
        deltas.sort((a, b) => a - b);
        resolve({ frames: deltas.length, p50: deltas[Math.floor(deltas.length / 2)], p95: deltas[Math.floor(deltas.length * 0.95)], max: deltas[deltas.length - 1] });
        return;
      }
      ts.scrollToPosition(-(i * 3), false);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }));
  const cb = await box();
  await page.evaluate(() => window.prims.forEach((p) => { p.hitCalls = 0; p.hitMs = 0; }));
  const t0 = Date.now();
  for (let k = 0; k < 60; k++) await page.mouse.move(cb.x + 100 + k * 10, cb.y + 200 + (k % 5) * 10);
  await frame();
  const mouseMs = Date.now() - t0;
  const hit = await page.evaluate(() => ({ calls: window.prims.reduce((a, p) => a + p.hitCalls, 0), ms: window.prims.reduce((a, p) => a + p.hitMs, 0) }));
  return { mode, n, scroll, hit, mouseMoves: 60, mouseMsWallclock: mouseMs };
}
results.perf = [];
for (const n of [0, 100, 500, 2000]) {
  for (const mode of ["one", "many"]) {
    if (n === 0 && mode === "many") continue;
    results.perf.push(await perf(mode, n));
  }
}
results.refreshRateNote = await page.evaluate(() => new Promise((r) => { const ts = []; function f(t) { ts.push(t); if (ts.length < 61) requestAnimationFrame(f); else r((ts[60] - ts[0]) / 60); } requestAnimationFrame(f); }));

await browser.close();
writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
