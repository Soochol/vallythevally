// Drive one journey against a running verify instance. run.sh calls this; do not start it by hand.
//   node drive.mjs <journey.mjs> <appUrl> <fakeUrl> <outDir>
// A journey module exports `default async function (page, ctx)` and returns an object of observations.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [journeyPath, appUrl, fakeUrl, out] = process.argv.slice(2);
const repo = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(repo, "web/package.json"));
const { chromium, expect } = require("@playwright/test");

const fake = {
  async pushReal(type, item, values) {
    const res = await fetch(`${fakeUrl}/_fake/ws/real`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, item, values }) });
    if (!res.ok) throw new Error(`/_fake/ws/real: HTTP ${res.status}`);
    return (await res.json()).delivered;
  },
  async registered() {
    return (await (await fetch(`${fakeUrl}/_fake/ws/stats`)).json()).registered;
  },
};

let shot = 0;
const browser = await chromium.launch({ chromiumSandbox: true });
const context = await browser.newContext({ baseURL: appUrl, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1440, height: 900 } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

const ctx = {
  appUrl, fake, expect, out,
  api: async (route) => (await fetch(`${appUrl}${route}`)).json(),
  screenshot: async (label) => {
    const file = path.join(out, `${String(++shot).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file });
    return file;
  },
};

let result, failure;
try {
  const journey = (await import(pathToFileURL(journeyPath).href)).default;
  result = await journey(page, ctx);
} catch (e) {
  failure = e;
  await ctx.screenshot("failure").catch(() => {});
} finally {
  await context.tracing.stop({ path: path.join(out, "trace.zip") });
  await browser.close();
}

const report = { journey: path.basename(journeyPath), ok: !failure, error: failure ? String(failure.stack ?? failure) : null, pageErrors: errors, observations: result ?? null };
await writeFile(path.join(out, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, pageErrors: errors.length, out }));
process.exit(failure ? 1 : 0);
