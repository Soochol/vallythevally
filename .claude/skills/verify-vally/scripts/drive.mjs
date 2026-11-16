#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { chromium, expect } = createRequire(join(root, "web/package.json"))("@playwright/test");
const [baseURL, evidence, journey] = process.argv.slice(2);
if (!baseURL || !evidence || !journey) throw new Error("usage: drive.mjs <base-url> <evidence-dir> <journey>");
mkdirSync(evidence, { recursive: true });

let tag = journey;
for (let n = 2; existsSync(join(evidence, `${tag}.json`)); n++) tag = `${journey}-${n}`;
const shot = (name) => join(evidence, `${tag}-${name}`);
const SEARCH_BUTTON_TITLE = "종목 검색 (/ 또는 Ctrl+K)";
const journeys = {
  async "search-chart"(page, log) {
    await page.goto("/");
    const cell = page.getByRole("region", { name: /^칸 1: / });
    await cell.waitFor();
    await expect(cell).toHaveAttribute("aria-busy", "false");
    log("opened", await cell.getAttribute("aria-label"));
    await expect(cell).toHaveAttribute("aria-label", /^칸 1: 코스피 /);
    await page.getByTitle(SEARCH_BUTTON_TITLE).click();
    const dialog = page.getByRole("dialog", { name: "종목 검색" });
    await dialog.getByRole("combobox", { name: "종목 검색" }).fill("삼성전자");
    const option = dialog.getByRole("option").filter({ hasText: "005930" }).first();
    await option.waitFor();
    await page.screenshot({ path: shot("01-search-results.png") });
    await option.click();
    await expect(cell).toHaveAttribute("aria-label", /삼성전자/);
    await expect(cell).toHaveAttribute("aria-busy", "false");
    const chart = cell.locator("[data-bar-count]");
    await expect(chart).not.toHaveAttribute("data-bar-count", "0");
    const bars = Number(await chart.getAttribute("data-bar-count"));
    log("chart", { label: await cell.getAttribute("aria-label"), bars, firstBarT: await chart.getAttribute("data-first-bar-t") });
    await page.screenshot({ path: shot("02-chart-after-search.png") });
    if (!(bars > 0)) throw new Error("no bars rendered");
    const uiState = await (await page.request.get("/api/ui-state")).json();
    log("server ui-state after search", uiState);
    return { label: await cell.getAttribute("aria-label"), bars };
  },
  async "watchlist-add"(page, log) {
    await page.goto("/");
    const panel = page.getByRole("complementary", { name: "관심종목" });
    await expect(panel.getByRole("button", { name: /^관심종목 목록: / })).toHaveAccessibleName("관심종목 목록: 기본");
    await expect(panel.locator("li[data-code]")).toHaveCount(0);
    await page.screenshot({ path: shot("01-watchlist-empty.png") });
    await panel.getByRole("button", { name: "관심종목에 넣기" }).click();
    const dialog = page.getByRole("dialog", { name: "관심종목에 넣을 종목 검색" });
    await dialog.getByRole("combobox", { name: "종목 검색" }).fill("삼성전자");
    await dialog.getByRole("option").filter({ hasText: "005930" }).first().click();
    await expect(panel.locator('li[data-code="005930"]')).toBeVisible();
    await page.screenshot({ path: shot("02-watchlist-added.png") });
    await expect.poll(async () => JSON.stringify(await (await page.request.get("/api/watchlists")).json())).toContain("005930");
    await page.reload();
    await expect(page.getByRole("complementary", { name: "관심종목" }).locator('li[data-code="005930"]')).toBeVisible();
    const stored = await (await page.request.get("/api/watchlists")).json();
    log("server watchlists after reload", stored);
    await page.screenshot({ path: shot("03-watchlist-after-reload.png") });
    return { codes: ["005930"] };
  },
};
if (!journeys[journey]) throw new Error(`unknown journey ${journey}; have ${Object.keys(journeys)}`);

const tmp = join(root, "target/t");
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch({ env: { ...process.env, TMPDIR: tmp }, chromiumSandbox: true });
const context = await browser.newContext({ baseURL, locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const requests = [];
const hosts = new Set();
const consoleErrors = [];
const steps = [];
page.on("request", (r) => hosts.add(new URL(r.url()).host));
page.on("websocket", (w) => hosts.add(new URL(w.url()).host));
page.on("response", (r) => { const u = new URL(r.url()); requests.push({ status: r.status(), method: r.request().method(), host: u.host, path: u.pathname + u.search }); });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const log = (...a) => { steps.push(a); console.log("drive:", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))); };
let outcome = { journey, ok: false };
try {
  const result = await journeys[journey](page, log);
  outcome = { journey, ok: true, result };
} catch (e) {
  outcome = { journey, ok: false, error: String(e) };
  await page.screenshot({ path: shot("failure.png") }).catch(() => {});
} finally {
  const allowed = new URL(baseURL).host;
  const foreignHosts = [...hosts].filter((h) => h !== allowed && h !== "");
  if (outcome.ok && (consoleErrors.length || foreignHosts.length)) outcome = { ...outcome, ok: false, error: `consoleErrors=${consoleErrors.length} foreignHosts=${foreignHosts.join(",")}` };
  writeFileSync(join(evidence, `${tag}.json`), JSON.stringify({ ...outcome, baseURL, steps, requests, foreignHosts, consoleErrors }, null, 1));
  await browser.close();
}
console.log(JSON.stringify(outcome));
process.exit(outcome.ok ? 0 : 1);
