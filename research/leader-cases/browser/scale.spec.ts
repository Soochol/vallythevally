import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "../playwright-tools.ts";
import type {} from "../report-browser.ts";

const directory = path.resolve(import.meta.dirname, "../../../target/leader-cases-173/scale");
let url: string;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, "../verify-size.ts")], { maxBuffer: 1024 * 1024 });
  const verification = JSON.parse(await readFile(path.join(directory, "verification.json"), "utf8"));
  url = pathToFileURL(verification.output).href;
});
test("full synthetic collection survives paged JSON, real offline charts and repeated lazy source evidence", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", (r) => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.context().setOffline(true);
  await page.goto(url, { timeout: 90_000 });
  await expect(page.locator("html")).toHaveAttribute("data-report-ready", "true", { timeout: 90_000 });
  expect(await page.locator("html").getAttribute("data-report-error")).toBeNull();
  for (const id of ["price", "relative-strength", "sector-rank", "institution"]) await expect(page.locator(`[data-panel="${id}"] canvas`).first()).toBeAttached();
  await page.locator('[data-panel="price"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "synthetic-scale-charts.png") });
  expect(await page.locator("details[data-evidence][data-loaded]").count()).toBe(0);
  await page.getByRole("checkbox", { name: "재무", exact: true }).check();
  const series = await page.evaluate(() => window.leaderReport.inspect().filter((c) => ["price", "financial-operating-profit", "financial-bps"].includes(c.id)).map((c) => ({ id: c.id, series: c.series })));
  const values = (id: string, title: string) => series.find((c) => c.id === id)!.series.filter((s) => s.title === title).flatMap((s) => s.data).filter((v): v is { time: string; value: number } => typeof v === "object" && v !== null && "time" in v && "value" in v && typeof v.time === "string" && typeof v.value === "number");
  expect(values("price", "PER 10배").find((p) => p.time === "2016-10-14")!.value).toBe(100);
  expect(values("price", "PER 10배").some((p) => p.time === "2016-10-17")).toBe(false);
  expect(values("financial-operating-profit", "영업이익 / 공시일 축 TTM").find((p) => p.time === "2016-10-14")?.value).toBe(200);
  expect(values("financial-bps", "BPS").find((p) => p.time === "2016-10-17")!.value).toBe(70);
  const publication = page.locator('[data-evidence="publication"]');
  await publication.locator(":scope > summary").click();
  const correction = publication.locator(":scope > details").filter({ has: page.locator("summary", { hasText: "2016-10-17" }) });
  await correction.locator(":scope > summary").click();
  const op = correction.locator(":scope > ul > li").filter({ hasText: /^operatingProfitTtm:/ });
  await expect(op).toContainText("ttm_path_conflict");
  await expect(op.locator('a[href*="20161014201520"]')).toBeAttached();
  const ni = correction.locator(":scope > ul > li").filter({ hasText: /^parentNetIncomeTtm:/ });
  await expect(ni.locator('a[href*="20161014201520"]')).toBeAttached();
  await op.locator(":scope > details > summary").click();
  const paths = op.locator(":scope > details > details").filter({ has: page.locator("summary", { hasText: /^paths$/ }) });
  await paths.locator(":scope > summary").click();
  await expect(paths.locator(":scope > details")).toHaveCount(2);
  for (const candidate of await paths.locator(":scope > details").all()) {
    await candidate.locator(":scope > summary").click();
    await candidate.getByText("result", { exact: true }).click();
  }
  await expect(paths).toContainText("value: 180");
  await expect(paths).toContainText("value: 200");
  await op.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, "synthetic-scale-ttm.png") });
  await page.locator("#accounting-mode").selectOption("annual");
  await expect(page.locator("#accounting-ledger table")).toHaveAttribute("data-mode", "annual");
  const sectorEvidence = page.locator('[data-evidence="sectors"]');
  await sectorEvidence.locator(":scope > summary").click();
  await sectorEvidence.getByText("series", { exact: true }).click();
  expect(await sectorEvidence.locator("pre").count()).toBeLessThan(10);
  await page.screenshot({ path: path.join(directory, "synthetic-scale-evidence.png") });
  const client = await page.context().newCDPSession(page);
  const heap = await client.send("Runtime.getHeapUsage");
  const browser = await page.context().browser()!.newBrowserCDPSession();
  const processes = await browser.send("SystemInfo.getProcessInfo");
  const renderers = [];
  for (const process of processes.processInfo.filter((p) => p.type === "renderer")) {
    const status = await readFile(`/proc/${process.id}/status`, "utf8");
    renderers.push({ pid: process.id, rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)![1]) });
  }
  await writeFile(path.join(directory, "browser.json"), JSON.stringify({ heap, renderers, pages: await page.locator("script.bundle-page").count(), errors, requests, url }, null, 2));
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});
