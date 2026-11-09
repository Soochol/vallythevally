import { type Page } from "@playwright/test";
import { parseDrawingBody, UNSAVED_PREFIX } from "../src/chart/drawings/outbox";
import { parseJournalRecord, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { test, expect, cell, chartOf, type App } from "./harness";

const width = (page: Page) => page.getByRole("toolbar", { name: "드로잉 스타일" }).getByLabel("선 굵기");

async function open(page: Page) {
  const loaded = page.waitForResponse((response) => response.url().includes("/api/drawings?") && response.request().method() === "GET");
  await page.goto("/");
  await (await loaded).finished();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}

async function createLine(page: Page) {
  const bounds = await chartOf(cell(page)).boundingBox();
  if (bounds === null) throw new Error("Expected the drawing chart");
  await cell(page).focus();
  await page.keyboard.press("H");
  await page.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.4);
}

async function storedDrawings(app: App) {
  const response = await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`);
  expect(response.status).toBe(200);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Expected the SQLite drawing list");
  return raw.map((item: unknown) => {
    const drawing = parseDrawingBody(item);
    if (drawing === null) throw new Error("Expected a valid persisted drawing");
    return drawing;
  });
}

async function pendingRecords(page: Page) {
  return page.evaluate(({ shared, stage }) => Object.keys(localStorage).filter((key) => key.startsWith(shared) || key.startsWith(stage)), { shared: UNSAVED_PREFIX, stage: STAGING_PREFIX });
}


test("actual app + HTTP/SQLite: first publication of an older never-sent PUT cannot revive a completed DELETE", async ({page, context, app}) => {
  await open(page); await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(app);
  if (!original) throw new Error("Expected seeded line");
  const other = await context.newPage(); await open(other);
  await page.getByRole("button", {name: "개체 목록 열기"}).click();
  await page.getByRole("button", {name: "고르기: 수평선"}).click();
  await other.getByRole("button", {name: "개체 목록 열기"}).click();
  await other.getByRole("button", {name: "고르기: 수평선"}).click();
  let release = () => {}; let held = false; let olderRecord: unknown;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/__parent-stage-gate", async (route) => { olderRecord = route.request().postDataJSON(); held = true; await gate; await route.fulfill({status: 200, body: "released"}); });
  const transport: {tab: string; method: string}[] = [];
  for (const [tab, p] of [["older", page], ["newer", other]] as const) p.on("request", request => {
    if (request.url().includes("/api/drawings/") && ["PUT", "DELETE"].includes(request.method())) transport.push({tab, method: request.method()});
  });
  await page.evaluate(() => {
    const native = Storage.prototype.setItem; let first = true;
    Storage.prototype.setItem = function (key, value) {
      if (first && key.startsWith("vv.unsaved.drawing-intent.")) {
        first = false;
        const gate = new XMLHttpRequest(); gate.open("POST", "/__parent-stage-gate", false); gate.setRequestHeader("content-type", "application/json"); gate.send(value);
      }
      native.call(this, key, value);
    };
  });
  await other.evaluate(() => {
    const native = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("vv.unsaved.drawing-intent.")) document.documentElement.dataset.latestStaged = value;
      native.call(this, key, value);
    };
  });
  const editing = width(page).selectOption("4", {timeout: 30000});
  try {
    await expect.poll(() => held).toBe(true);
    expect(transport).toEqual([]);
    await other.getByRole("button", {name: "드로잉 지우기", exact: true}).click();
    await expect(other.getByText(/^자동 저장됨 /)).toBeVisible();
    expect(await storedDrawings(app)).toEqual([]);
    expect(await pendingRecords(other)).toEqual([]);
    expect(transport).toEqual([{tab: "newer", method: "DELETE"}]);
    const newerRecord = JSON.parse(await other.locator("html").getAttribute("data-latest-staged") ?? "null");
    const parsedOlder=parseJournalRecord(olderRecord); const parsedNewer=parseJournalRecord(newerRecord);
    if (parsedOlder === null || parsedNewer === null) throw new Error("Expected reserved intent records");
    expect(parsedOlder.order).toBeLessThan(parsedNewer.order);
    console.log("R1_BEFORE_RELEASE", JSON.stringify({ olderRecord, newerRecord, transport, db: await storedDrawings(app), journal: await pendingRecords(other) }));
    release(); await editing;
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
    const final = await storedDrawings(app);
    console.log("APP_STAGE_CLEANUP_RACE", JSON.stringify({originalRevision: original.revision, olderRecord, newerRecord, transport, final, keys: await pendingRecords(other)}));
    expect(final).toEqual([]);
  } finally { release(); await editing; }
});
