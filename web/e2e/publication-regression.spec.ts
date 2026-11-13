import { selectOption } from "./select-option";
import type { Page } from "@playwright/test";
import { parseDrawingBody, UNSAVED_PREFIX } from "../src/chart/drawings/outbox";
import { parseJournalRecord, COMPLETION_PREFIX, completionKey, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { test, expect, cell, chartOf, type Scenario } from "./harness";

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

async function storedDrawings(scenario: Scenario) {
  const response = scenario.documents.drawings("IDX:001");
  const raw: unknown = response;
  if (!Array.isArray(raw)) throw new Error("Expected the saved drawing list");
  return raw.map((item: unknown) => {
    const drawing = parseDrawingBody(item);
    if (drawing === null) throw new Error("Expected a valid persisted drawing");
    return drawing;
  });
}

async function pendingRecords(page: Page) {
  return page.evaluate(({ shared, stage }) => Object.keys(localStorage).filter((key) => key.startsWith(shared) || key.startsWith(stage)), { shared: UNSAVED_PREFIX, stage: STAGING_PREFIX });
}


const DIAGNOSTIC_REGISTRATION_PREFIX = "r1.diagnostic.registration.";
async function protocolRecords(page: Page) {
  return page.evaluate(prefix => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => [key, JSON.parse(localStorage.getItem(key) ?? "null")])), COMPLETION_PREFIX);
}

test("actual scenario + HTTP/SQLite: first publication of an older never-sent PUT cannot revive a completed DELETE", async ({page, context, scenario}, info) => {
  await open(page); await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(scenario);
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
  const editing = selectOption(width(page), "4", {timeout: 30000});
  try {
    await expect.poll(() => held).toBe(true);
    expect(transport).toEqual([]);
    await other.getByRole("button", {name: "드로잉 지우기", exact: true}).click();
    await expect(other.getByText(/^자동 저장됨 /)).toBeVisible();
    expect(await storedDrawings(scenario)).toEqual([]);
    expect(await pendingRecords(other)).toEqual([]);
    expect(transport).toEqual([{tab: "newer", method: "DELETE"}]);
    const newerRecord = JSON.parse(await other.locator("html").getAttribute("data-latest-staged") ?? "null");
    const parsedOlder=parseJournalRecord(olderRecord); const parsedNewer=parseJournalRecord(newerRecord);
    if (parsedOlder === null || parsedNewer === null) throw new Error("Expected reserved intent records");
    expect(parsedOlder.order).toBeLessThan(parsedNewer.order);
    const protocolBeforeRelease = await protocolRecords(other);
    expect(protocolBeforeRelease[completionKey(parsedOlder.id)]).toMatchObject({ order: parsedNewer.order, uuid: parsedNewer.uuid });
    expect(Object.keys(protocolBeforeRelease)).toEqual([completionKey(original.id)]);
    console.log("R1_BEFORE_RELEASE", JSON.stringify({ olderRecord, newerRecord, transport, db: await storedDrawings(scenario), journal: await pendingRecords(other), protocolBeforeRelease }));
    release(); await editing;
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
    const final = await storedDrawings(scenario);
    console.log("APP_STAGE_CLEANUP_RACE", JSON.stringify({originalRevision: original.revision, olderRecord, newerRecord, transport, final, keys: await pendingRecords(other)}));
    expect(final).toEqual([]);
    expect(transport).toEqual([{tab: "newer", method: "DELETE"}]);
    await expect.poll(() => pendingRecords(other)).toEqual([]);
    await expect.poll(async () => Object.keys(await protocolRecords(other))).toEqual([completionKey(original.id)]);
    await info.attach("reserved-first-publication.json", { body: JSON.stringify({ olderRecord, newerRecord, protocolBeforeRelease, transport, final }), contentType: "application/json" });
    await other.screenshot({ path: info.outputPath("r1-delete-remains.png") });
  } finally { release(); await editing; }
});


test("actual scenario + HTTP/SQLite: native launch holds the id lock only until fetch starts, not until its ACK", async ({ page, context, scenario }, info) => {
  await open(page);
  await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(scenario);
  if (!original) throw new Error("Expected the saved line");
  const other = await context.newPage();
  await open(other);
  for (const tab of [page, other]) {
    await tab.getByRole("button", { name: "개체 목록 열기" }).click();
    await tab.getByRole("button", { name: "고르기: 수평선" }).click();
  }
  let releasePut = () => {};
  let releaseDelete = () => {};
  let releaseAck = () => {};
  const putGate = new Promise<void>(done => { releasePut = done; });
  const deleteGate = new Promise<void>(done => { releaseDelete = done; });
  const ackGate = new Promise<void>(done => { releaseAck = done; });
  let putHeld = false;
  let deleteHeld = false;
  let putStored = false;
  const transport: string[] = [];
  for (const tab of [page, other]) tab.on("request", request => {
    if (request.url().includes("/api/drawings/") && ["PUT", "DELETE"].includes(request.method())) transport.push(request.method());
  });
  await page.route("**/__r1-put-launch", async route => {
    putHeld = true; await putGate; await route.fulfill({ status: 200, body: "released" });
  });
  await other.route("**/__r1-delete-launch", async route => {
    deleteHeld = true; await deleteGate; await route.fulfill({ status: 200, body: "released" });
  });
  await page.route(`**/api/drawings/${original.id}`, async route => {
    const response = await scenario.respond(route.request());
    putStored = true;
    await ackGate;
    await route.fulfill({ status: response.status ?? 200, json: response.body, headers: response.headers });
  });
  for (const [tab, method, gate] of [[page, "PUT", "/__r1-put-launch"], [other, "DELETE", "/__r1-delete-launch"]] as const) {
    await tab.evaluate(({ method, gate }) => {
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        if (init?.method === method && String(input).includes("/api/drawings/")) {
          const request = new XMLHttpRequest();
          request.open("POST", gate, false);
          request.send();
        }
        return nativeFetch(input, init);
      };
    }, { method, gate });
  }
  const editing = selectOption(width(page), "4", { timeout: 30000 });
  let deleting: Promise<void> | undefined;
  try {
    await expect.poll(() => putHeld).toBe(true);
    expect(transport).toEqual([]);
    deleting = other.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
    await expect.poll(() => other.evaluate(async id => (await navigator.locks.query()).pending?.filter(lock => lock.name === `vv.drawing.journal.${id}`).length, original.id)).toBeGreaterThan(0);
    expect(deleteHeld).toBe(false);
    expect(await storedDrawings(scenario)).toEqual([original]);
    releasePut();
    await editing;
    await expect.poll(() => deleteHeld && putStored).toBe(true);
    expect(transport).toEqual(["PUT"]);
    expect((await storedDrawings(scenario))[0]?.style).toMatchObject({ line: { width: 4 } });
    releaseDelete();
    await deleting;
    await expect(other.getByText(/^자동 저장됨 /)).toBeVisible();
    expect(await storedDrawings(scenario)).toEqual([]);
    releaseAck();
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
    expect(transport).toEqual(["PUT", "DELETE"]);
    expect(await storedDrawings(scenario)).toEqual([]);
    await expect.poll(() => pendingRecords(other)).toEqual([]);
    await expect.poll(async () => Object.keys(await protocolRecords(other))).toEqual([completionKey(original.id)]);
    await info.attach("native-launch-http-boundary.json", { body: JSON.stringify({ transport, putStored, deleteHeld, final: await storedDrawings(scenario) }), contentType: "application/json" });
  } finally {
    releasePut(); releaseDelete(); releaseAck();
    await Promise.allSettled([editing, ...(deleting ? [deleting] : [])]);
  }
});

test("actual scenario + HTTP/SQLite: a warm Storage task paused before diagnostic registration cannot publish below a completed DELETE", async ({ page, context, scenario }) => {
  await open(page);
  await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(scenario);
  if (!original) throw new Error("Expected the seeded drawing");
  const other = await context.newPage();
  await open(other);
  for (const tab of [page, other]) {
    await tab.getByRole("button", { name: "개체 목록 열기" }).click();
    await tab.getByRole("button", { name: "고르기: 수평선" }).click();
  }
  let release = () => {};
  let held = false;
  const gate = new Promise<void>(done => { release = done; });
  await page.route("**/__r1-warm-registration", async route => {
    held = true; await gate; await route.fulfill({ status: 200, body: "released" });
  });
  const transport: { tab: string; method: string }[] = [];
  for (const [name, tab] of [["older", page], ["newer", other]] as const) tab.on("request", request => {
    if (request.url().includes("/api/drawings/") && ["PUT", "DELETE"].includes(request.method())) transport.push({ tab: name, method: request.method() });
  });
  await page.evaluate(({ registration, staging, floor, clock }) => {
    localStorage.getItem(floor);
    Date.now = () => clock;
    const nativeUuid = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = () => {
      const uuid = nativeUuid();
      localStorage.setItem(`${registration}${uuid}`, JSON.stringify({ uuid, diagnostic: true }));
      return uuid;
    };
    const nativeSet = Storage.prototype.setItem;
    let first = true;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith(staging)) document.documentElement.dataset.resumedIntent = value;
      if (first && key.startsWith(registration)) {
        first = false;
        localStorage.getItem(floor);
        const request = new XMLHttpRequest();
        request.open("POST", "/__r1-warm-registration", false);
        request.send(value);
      }
      nativeSet.call(this, key, value);
    };
  }, { registration: DIAGNOSTIC_REGISTRATION_PREFIX, staging: STAGING_PREFIX, floor: completionKey(original.id), clock: original.revision - 60000 });
  await other.evaluate(staging => {
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith(staging)) document.documentElement.dataset.terminalIntent = value;
      nativeSet.call(this, key, value);
    };
  }, STAGING_PREFIX);
  const editing = selectOption(width(page), "4", { timeout: 30000 });
  try {
    await expect.poll(() => held).toBe(true);
    expect(transport).toEqual([]);
    await other.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
    await expect(other.getByText(/^자동 저장됨 /)).toBeVisible();
    expect(await storedDrawings(scenario)).toEqual([]);
    expect(await pendingRecords(other)).toEqual([]);
    expect(transport).toEqual([{ tab: "newer", method: "DELETE" }]);
    const terminal = parseJournalRecord(JSON.parse(await other.locator("html").getAttribute("data-terminal-intent") ?? "null"));
    const before = { terminal, transport: [...transport], protocol: await protocolRecords(other) };
    release(); await editing;
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
    const resumed = parseJournalRecord(JSON.parse(await page.locator("html").getAttribute("data-resumed-intent") ?? "null"));
    const final = await storedDrawings(scenario);
    console.log("WARM_REGISTRATION_APP", JSON.stringify({ before, resumed, transport, final }));
    expect(final).toEqual([]);
  } finally { release(); await editing; }
});
