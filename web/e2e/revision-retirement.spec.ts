import type { Page } from "@playwright/test";
import { parseDrawingBody, UNSAVED_PREFIX } from "../src/chart/drawings/outbox";
import { parseJournalRecord, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { test, expect, cell, chartOf, type Scenario } from "./harness";

async function open(page: Page) {
  const loaded = page.waitForResponse((response) => response.url().includes("/api/drawings?") && response.request().method() === "GET");
  await page.goto("/");
  await (await loaded).finished();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
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


test("startup legacy read failure then late ACK retains revision maximum for backward-clock Undo", async ({ page, context, scenario }, info) => {
  const original: Parameters<Scenario["documents"]["saveDrawing"]>[0] = { id: "01900000-0000-7000-8000-000000000053", symbol: "IDX:001", tool: "hline", points: [{ t: 1_700_000_000, price: 100 }], text: null, style: {}, locked: false, hidden: false, periods: null, z: 0, group: null, scope: { kind: "symbol" }, revision: 1 };
  scenario.documents.saveDrawing(original);

  await page.addInitScript(original => {
    const legacyKey = `vv.unsaved.drawing.${original.id}`;
    localStorage.setItem(legacyKey, JSON.stringify({ v: 1, id: original.id, symbol: original.symbol, want: { kind: "put", body: { ...original, revision: 0 } }, lastRevision: 0 }));
    const nativeGet = Storage.prototype.getItem;
    let failOnce = true;
    Storage.prototype.getItem = function(key) {
      if (key === legacyKey && failOnce) {
        failOnce = false;
        throw new DOMException("One transient initial legacy read failure", "SecurityError");
      }
      return nativeGet.call(this, key);
    };
  }, original);
  await open(page);
  await expect(page.getByRole("button", { name: "다시 시도", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`vv.unsaved.drawing.${id}`) ?? "null"), original.id)).toMatchObject({ v: 1, lastRevision: 0, want: { kind: "put", body: { revision: 0 } } });
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  await page.getByRole("button", { name: "고르기: 수평선" }).click();
  let releaseDelete = () => {};
  const deleteGate = new Promise<void>(done => { releaseDelete = done; });
  let deleteStage: unknown;
  await page.route("**/__review-delete-stage", async route => {
    deleteStage = route.request().postDataJSON();
    await deleteGate;
    if (!page.isClosed()) await route.fulfill({ status: 200, body: "released" });
  });
  await page.evaluate(() => {
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith("vv.unsaved.drawing-intent.") && JSON.parse(value).want.kind === "delete") {
        const gate = new XMLHttpRequest(); gate.open("POST", "/__review-delete-stage", false); gate.send(value);
      }
      nativeSet.call(this, key, value);
    };
  });
  const deleting = page.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
  const other = await context.newPage();
  let releaseAck = () => {};
  const ackGate = new Promise<void>(done => { releaseAck = done; });
  let putBody: unknown;
  let putStored = false;
  await other.route(`**/api/drawings/${original.id}`, async route => {
    putBody = route.request().postDataJSON();
    const response = await scenario.respond(route.request());
    expect((response.status ?? 200)).toBe(200);
    putStored = true;
    await ackGate;
    if (!other.isClosed()) await route.fulfill({ status: response.status ?? 200, json: response.body, headers: response.headers });
  });
  try {
    await expect.poll(() => deleteStage !== undefined).toBe(true);
    await open(other);
    await expect.poll(() => putStored).toBe(true);
    const storedBeforeDelete = await storedDrawings(scenario);
    const terminal = parseJournalRecord(deleteStage);
    if (!terminal) throw new Error("Expected reserved DELETE");
    expect(terminal.want.kind).toBe("delete");
    expect(terminal.lastRevision).toBe(1);
    const legacyStage = parseJournalRecord(await other.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith("vv.unsaved.drawing-intent."));
      return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
    }));
    if (!legacyStage) throw new Error("Expected migrated PUT stage before DELETE");
    expect(legacyStage.order).toBe(0);
    expect(legacyStage.order).toBeLessThan(terminal.order);
    expect(storedBeforeDelete).toHaveLength(1);
    expect(storedBeforeDelete[0]?.revision).toBe(legacyStage.lastRevision);
    releaseDelete();
    await deleting;
    await expect.poll(() => storedDrawings(scenario)).toEqual([]);
    await expect.poll(() => pendingRecords(page)).toEqual([]);
    const afterDelete = await page.evaluate(id => JSON.parse(localStorage.getItem(`vv.drawing.completed.${id}`) ?? "null"), original.id);
    releaseAck();
    await expect(other.getByText(/^자동 저장됨 /)).toBeVisible();
    const afterAck = await page.evaluate(id => JSON.parse(localStorage.getItem(`vv.drawing.completed.${id}`) ?? "null"), original.id);
    const serverAfterAck = await storedDrawings(scenario);
    expect(serverAfterAck).toEqual([]);
    expect(afterAck.order).toBe(afterDelete.order);
    expect(afterAck.uuid).toBe(afterDelete.uuid);
    const beforeUndoKeys = await pendingRecords(page);
    expect(beforeUndoKeys).toEqual([]);
    const acknowledged = parseDrawingBody(putBody);
    if (!acknowledged) throw new Error("Expected acknowledged legacy body");
    await page.evaluate(clock => { Date.now = () => clock; }, acknowledged.revision - 60_000);
    await cell(page).focus();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await storedDrawings(scenario)).length).toBe(1);
    const afterUndo = await storedDrawings(scenario);
    const evidence = { legacyStage, deleteStage, putBody, storedBeforeDelete, afterDelete, afterAck, serverAfterAck, beforeUndoKeys, afterUndo };
    console.log(JSON.stringify(evidence));
    await info.attach("legacy-late-ack-revision.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    const [legacySaved] = storedBeforeDelete;
    if (!legacySaved) throw new Error("missing legacy PUT");
    expect.soft(afterDelete.lastRevision).toBe(legacySaved.revision);
    expect.soft(afterAck.lastRevision).toBe(legacySaved.revision);
    expect(afterUndo[0]?.revision).toBeGreaterThan(legacySaved.revision);
  } finally {
    releaseDelete(); releaseAck();
    await Promise.allSettled([deleting]);
  }
});
