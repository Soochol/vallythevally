import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../playwright-tools.ts";
import { syntheticInputs } from "../fixtures/report.ts";
import { GZIP_DAMAGE, damagedGzipDocument, gzipWithOptionalHeader } from "../fixtures/gzip-pages.ts";
import { encodeBundle } from "../bundle-storage.ts";
import { browserBundle } from "../generate-report.ts";
import { reportPage } from "../report-page.ts";
import { holdDecoder } from "./decoder-gate.ts";

const root = path.resolve(import.meta.dirname, "../../../target/leader-cases-173/review-fix-1/browser");
let goodUrl: string;
let optionalUrl: string;
const corruptUrls: string[] = [];
test.beforeAll(async () => {
  await mkdir(root, { recursive: true });
  const { bundle, manuscript } = await syntheticInputs(root);
  const document = await encodeBundle(bundle), script = await browserBundle();
  const good = path.join(root, "good.html");
  await writeFile(good, reportPage(bundle, manuscript, script, document));
  goodUrl = pathToFileURL(good).href;
  const optional = path.join(root, "optional-header.html");
  await writeFile(optional, reportPage(bundle, manuscript, script, { ...document, pages: document.pages.map((p, i) => i === 0 ? gzipWithOptionalHeader(p) : p) }));
  optionalUrl = pathToFileURL(optional).href;
  for (const index of [0, Math.floor(document.pages.length / 2)]) for (const kind of GZIP_DAMAGE) {
    const filename = path.join(root, `${index}-${kind}.html`);
    await writeFile(filename, reportPage(bundle, manuscript, script, damagedGzipDocument(document, index, kind)));
    corruptUrls.push(pathToFileURL(filename).href);
  }
});
test("Chromium accepts a single member and rejects residual bytes and connected members at either page position", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.context().setOffline(true);
  for (const url of [goodUrl, optionalUrl]) {
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("data-report-ready", "true");
    await expect(page.locator('[data-panel="price"] canvas').first()).toBeAttached();
  }
  for (const url of corruptUrls) {
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("data-report-error", "bundle_input");
    expect(await page.locator("html").getAttribute("data-report-ready")).toBeNull();
    await expect(page.locator("canvas")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
test("evidence opened during a gated decode renders once when the report becomes ready", async ({ page }) => {
  await page.context().setOffline(true);
  const release = await holdDecoder(page);
  await page.goto(goodUrl);
  const evidence = page.locator('[data-evidence="publication"]');
  await evidence.locator(":scope > summary").click();
  await expect(evidence).toHaveAttribute("data-early-toggle-seen", "true");
  expect(await page.locator("html").getAttribute("data-report-ready")).toBeNull();
  expect(await evidence.locator(":scope > details").count()).toBe(0);
  await release();
  await expect(page.locator("html")).toHaveAttribute("data-report-ready", "true");
  await expect(evidence).toHaveAttribute("data-loaded", "true");
  const count = await evidence.locator(":scope > details").count();
  expect(count).toBeGreaterThan(0);
  await expect(page.locator('details[data-evidence][data-loaded="true"]')).toHaveCount(1);
  await evidence.locator(":scope > summary").click();
  await expect(evidence).not.toHaveAttribute("open", "");
  await evidence.locator(":scope > summary").click();
  await expect(evidence).toHaveAttribute("open", "");
  await expect(evidence.locator(":scope > details")).toHaveCount(count);
});
