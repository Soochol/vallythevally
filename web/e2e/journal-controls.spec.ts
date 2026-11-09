import { test as browserTest, type Page } from "@playwright/test";
import path from "node:path";
import { createServer } from "vite";
import { parseDrawingBody, recordKey, UNSAVED_PREFIX } from "../src/chart/drawings/outbox";
import { parseJournalRecord, stageKey, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { test, expect, cell, chartOf, type App } from "./harness";
import type {} from "./journal-probe";

const mirror = (page: Page) => chartOf(cell(page)).locator(".drawing-mirror");
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

test("actual app + HTTP/SQLite: delayed older admission cannot replace the same document's newer DELETE", async ({ page, app }, info) => {
  await open(page);
  await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(app);
  if (original === undefined) throw new Error("Expected the seeded drawing");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/drawings/") && ["PUT", "DELETE"].includes(request.method())) requests.push(request.method());
  });
  await page.evaluate((id) => new Promise<void>((acquired) => {
    void navigator.locks.request(`vv.drawing.journal.${id}`, async () => {
      const released = new Promise<void>((resolve) => window.addEventListener("release-journal-control", () => resolve(), { once: true }));
      acquired();
      await released;
    });
  }), original.id);
  try {
    await page.getByRole("button", { name: "개체 목록 열기" }).click();
    await page.getByRole("button", { name: "고르기: 수평선" }).click();
    await width(page).selectOption("3");
    await expect(width(page)).toHaveValue("3");
    await page.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
    await expect(mirror(page)).toHaveAttribute("data-drawings", "[]");
    expect(await pendingRecords(page)).toHaveLength(2);
    const locks = await page.evaluate(() => navigator.locks.query());
    expect(locks.pending?.filter((lock) => lock.name === `vv.drawing.journal.${original.id}`).length).toBeGreaterThan(0);
    expect(requests).toEqual([]);
    await page.evaluate(() => window.dispatchEvent(new Event("release-journal-control")));
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
    await expect.poll(() => storedDrawings(app)).toEqual([]);
    await expect.poll(() => pendingRecords(page)).toEqual([]);
    expect(requests).toEqual(["DELETE"]);
    await open(page);
    await expect(mirror(page)).toHaveAttribute("data-drawings", "[]");
    expect(await storedDrawings(app)).toEqual([]);
    expect(requests).toEqual(["DELETE"]);
    await info.attach("same-document-admission.json", { body: JSON.stringify({ locks, requests }, null, 2), contentType: "application/json" });
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event("release-journal-control")));
  }
});

for (const failure of ["locks-unsupported", "locks-rejected", "staging-write", "shared-write"] as const) {
  test(`actual app + HTTP/SQLite: ${failure} reports failure without unsafe transport`, async ({ page, app }, info) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/drawings/") && ["PUT", "DELETE"].includes(request.method())) requests.push(request.method());
    });
    await page.addInitScript(({ mode, shared, stage }) => {
      if (mode === "locks-unsupported") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      else if (mode === "locks-rejected") navigator.locks.request = () => Promise.reject(new DOMException("Injected lock rejection", "SecurityError"));
      else {
        const nativeSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          const isStage = key.startsWith(stage);
          const isShared = key.startsWith(shared) && !isStage;
          if ((mode === "staging-write" && isStage) || (mode === "shared-write" && isShared)) {
            throw new DOMException("Injected journal write failure", "QuotaExceededError");
          }
          nativeSet.call(this, key, value);
        };
      }
    }, { mode: failure, shared: UNSAVED_PREFIX, stage: STAGING_PREFIX });
    await open(page);
    await createLine(page);
    const retry = page.getByRole("button", { name: "다시 시도", exact: true }).first();
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toBeVisible();
    expect(await storedDrawings(app)).toEqual([]);
    expect(requests).toEqual([]);
    const records = await pendingRecords(page);
    expect(records).toHaveLength(failure === "staging-write" ? 0 : 1);
    expect(records.every((key) => key.startsWith(STAGING_PREFIX))).toBe(true);
    await info.attach("failure-boundary.json", { body: JSON.stringify({ failure, requests, records }, null, 2), contentType: "application/json" });
  });
}

test("actual app + HTTP/SQLite: reload transmits the staged PUT's fixed revision", async ({ page, app }, info) => {
  await open(page);
  await createLine(page);
  await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
  const [original] = await storedDrawings(app);
  if (original === undefined) throw new Error("Expected the seeded drawing");
  await page.evaluate(() => {
    Date.now = () => 400;
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      if (init?.method === "PUT" && String(input).includes("/api/drawings/")) {
        document.documentElement.dataset.heldDrawingPut = "true";
        return new Promise<Response>(() => {});
      }
      return nativeFetch(input, init);
    };
  });
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  await page.getByRole("button", { name: "고르기: 수평선" }).click();
  await width(page).selectOption("3");
  await expect(page.locator("html")).toHaveAttribute("data-held-drawing-put", "true");
  const raw = await page.evaluate((id) => localStorage.getItem(`vv.unsaved.drawing.${id}`), original.id);
  const staged = raw === null ? null : parseJournalRecord(JSON.parse(raw));
  if (staged?.want.kind !== "put") throw new Error("Expected a staged reserved PUT");
  expect(staged.want.body.revision).toBe(original.revision + 1);
  const sent: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/drawings/")) sent.push(request.postDataJSON());
  });
  await open(page);
  await expect.poll(async () => (await storedDrawings(app))[0]?.style).toMatchObject({ line: { width: 3 } });
  await expect.poll(() => pendingRecords(page)).toEqual([]);
  expect((await storedDrawings(app))[0]?.revision).toBe(staged.want.body.revision);
  expect(sent).toEqual([staged.want.body]);
  await info.attach("restored-fixed-revision.json", { body: JSON.stringify({ staged, sent }, null, 2), contentType: "application/json" });
});

const adapterTest = browserTest.extend<{ journalUrl: string }>({
  journalUrl: async ({}, use) => {
    const server = await createServer({
      root: path.resolve(import.meta.dirname, ".."), configFile: false, envDir: false, appType: "custom",
      server: { host: "127.0.0.1", port: 0 },
    });
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><script type="module" src="/e2e/journal-probe.ts"></script>');
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === "string") throw new Error("Expected the loopback journal adapter server");
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await server.close(); }
  },
});

async function openAdapter(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => window.journalProbe !== undefined);
}

for (const first of ["cleanup", "admission"] as const) {
  adapterTest(`actual journal adapter: old ACK cleanup and newer admission preserve the newer intent when ${first} gets the lock first`, async ({ page, journalUrl }, info) => {
    await openAdapter(page, journalUrl);
    const admitted = await page.evaluate(async () => {
      const probe = window.journalProbe;
      const journal = new probe.DrawingJournal();
      const older = journal.stage({ id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: probe.body }, observedRevision: 0 }, () => 100);
      await journal.admit(older);
      const newer = journal.stage({ id: probe.body.id, symbol: probe.body.symbol, want: { kind: "delete" }, observedRevision: older.lastRevision }, () => 100);
      probe.intents.set("older", older);
      probe.intents.set("newer", newer);
      await new Promise<void>((acquired) => {
        void navigator.locks.request(probe.journalLock(probe.body.id), async () => {
          const released = new Promise<void>((resolve) => { probe.release = resolve; });
          acquired();
          await released;
        });
      });
      return { older, newer };
    });
    try {
      await page.evaluate((firstOperation) => {
        const probe = window.journalProbe;
        const journal = new probe.DrawingJournal();
        const older = probe.intents.get("older");
        const newer = probe.intents.get("newer");
        if (older === undefined || newer === undefined) throw new Error("Expected staged intents");
        const cleanup = () => { probe.tasks.set("cleanup", journal.complete(older)); };
        const admission = () => { probe.tasks.set("admission", journal.admit(newer)); };
        if (firstOperation === "cleanup") { cleanup(); admission(); } else { admission(); cleanup(); }
      }, first);
      await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.length)).toBe(2);
      const locks = await page.evaluate(() => navigator.locks.query());
      const result = await page.evaluate(async () => {
        const probe = window.journalProbe;
        probe.release();
        await Promise.all(probe.tasks.values());
        const journal = new probe.DrawingJournal();
        const newest = await journal.recover(probe.body.id);
        const pending = Object.keys(localStorage).filter((key) => key.startsWith(probe.UNSAVED_PREFIX) || key.startsWith(probe.STAGING_PREFIX));
        return { newest, pending };
      });
      expect(result.newest).toEqual(admitted.newer);
      expect(result.pending.sort()).toEqual([
        recordKey(admitted.newer.id), stageKey(admitted.newer.uuid),
      ].sort());
      const settled = await page.evaluate(async () => {
        const probe = window.journalProbe;
        const journal = new probe.DrawingJournal();
        const older = probe.intents.get("older");
        const newer = probe.intents.get("newer");
        if (older === undefined || newer === undefined) throw new Error("Expected staged intents");
        await journal.complete(newer);
        return { resurrected: await journal.admit(older), recovered: await journal.recover(probe.body.id), records: Object.keys(localStorage) };
      });
      expect(settled).toEqual({ resurrected: false, recovered: null, records: [] });
      await page.reload();
      await page.waitForFunction(() => window.journalProbe !== undefined);
      expect(await page.evaluate(() => new window.journalProbe.DrawingJournal().recover(window.journalProbe.body.id))).toBeNull();
      await info.attach("journal-adapter-lock-order.json", { body: JSON.stringify({ first, locks, admitted, result, settled }, null, 2), contentType: "application/json" });
    } finally { await page.evaluate(() => window.journalProbe.release()); }
  });
}

adapterTest("actual journal adapter: stale legacy recovery respects a newer v2 write and restores its fixed revision", async ({ page, journalUrl }, info) => {
  await openAdapter(page, journalUrl);
  const state = await page.evaluate(async () => {
    const probe = window.journalProbe;
    const legacy = { v: 1, id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: { ...probe.body, revision: 731 }, reserved: true }, lastRevision: 731 };
    localStorage.setItem(probe.recordKey(probe.body.id), JSON.stringify(legacy));
    const reader = new probe.DrawingJournal();
    const migrated = await reader.recover(probe.body.id);
    localStorage.clear();
    localStorage.setItem(probe.recordKey(probe.body.id), JSON.stringify(legacy));
    const staleSnapshot = reader.snapshot();
    await new Promise<void>((acquired) => {
      void navigator.locks.request(probe.journalLock(probe.body.id), async () => {
        const released = new Promise<void>((resolve) => { probe.release = resolve; });
        acquired();
        await released;
      });
    });
    const writer = new probe.DrawingJournal();
    const newer = writer.stage({ id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: { ...probe.body, text: "newer" } }, observedRevision: 731 }, () => 800);
    probe.tasks.set("admission", writer.admit(newer));
    probe.tasks.set("migration", reader.recover(probe.body.id));
    return { migrated, staleSnapshot, newer };
  });
  try {
    expect(state.migrated?.want).toMatchObject({ kind: "put", body: { revision: 731 } });
    expect(state.staleSnapshot.intents).toEqual([]);
    expect(state.staleSnapshot.ids).toEqual([state.newer.id]);
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.length)).toBe(2);
    const recovered = await page.evaluate(async () => {
      const probe = window.journalProbe;
      probe.release();
      await Promise.all(probe.tasks.values());
      return new probe.DrawingJournal().recover(probe.body.id);
    });
    expect(recovered).toEqual(state.newer);
    expect(recovered?.want).toMatchObject({ kind: "put", body: { revision: 800, text: "newer" } });
    await page.reload();
    await page.waitForFunction(() => window.journalProbe !== undefined);
    expect(await page.evaluate(() => new window.journalProbe.DrawingJournal().recover(window.journalProbe.body.id))).toEqual(state.newer);
    await info.attach("journal-adapter-migration.json", { body: JSON.stringify({ state, recovered }, null, 2), contentType: "application/json" });
  } finally { await page.evaluate(() => window.journalProbe.release()); }
});

adapterTest("actual journal adapter: stopped clocks respect revision floors and custom ids cannot alias staging keys", async ({ page, journalUrl }, info) => {
  await openAdapter(page, journalUrl);
  const result = await page.evaluate(async () => {
    const probe = window.journalProbe;
    const firstWriter = new probe.DrawingJournal();
    const secondWriter = new probe.DrawingJournal();
    const input = { id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: probe.body }, observedRevision: 0 } satisfies Parameters<typeof firstWriter.stage>[0];
    const first = firstWriter.stage({ ...input, observedRevision: 900 }, () => 100);
    await firstWriter.admit(first);
    const second = secondWriter.stage({ ...input, observedRevision: 950 }, () => 50);
    const third = firstWriter.stage({ ...input, observedRevision: 0 }, () => 0);
    const fourth = firstWriter.stage({ ...input, observedRevision: 0 }, () => 0);
    const customId = `intent.${first.uuid}`;
    const custom = secondWriter.stage({ id: customId, symbol: probe.body.symbol, want: { kind: "delete" }, observedRevision: 0 }, () => 0);
    await secondWriter.admit(custom);
    const parseAt = (key: string) => {
      const raw = localStorage.getItem(key);
      return raw === null ? null : probe.parseJournalRecord(JSON.parse(raw));
    };
    return {
      first, second, third, fourth, custom,
      originalStage: parseAt(probe.stageKey(first.uuid)), customShared: parseAt(probe.recordKey(customId)),
      stageKey: probe.stageKey(first.uuid), sharedKey: probe.recordKey(customId), snapshot: firstWriter.snapshot(),
    };
  });
  expect([result.first, result.second, result.third, result.fourth].map((intent) => intent.order)).toEqual([100, 101, 102, 103]);
  expect([result.first, result.second, result.third, result.fourth].map((intent) => intent.lastRevision)).toEqual([901, 951, 952, 953]);
  expect(result.originalStage).toEqual(result.first);
  expect(result.customShared).toEqual(result.custom);
  expect(result.stageKey).not.toBe(result.sharedKey);
  expect(result.snapshot.intents).toEqual(expect.arrayContaining([result.fourth, result.custom]));
  await info.attach("journal-adapter-boundaries.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});

adapterTest("actual journal adapter: cleanup storage failure preserves the latest DELETE until older intents are retired", async ({ page, journalUrl }, info) => {
  await openAdapter(page, journalUrl);
  const result = await page.evaluate(async () => {
    const probe = window.journalProbe;
    const journal = new probe.DrawingJournal();
    const older = journal.stage({ id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: probe.body }, observedRevision: 0 }, () => 100);
    await journal.admit(older);
    const latest = journal.stage({ id: probe.body.id, symbol: probe.body.symbol, want: { kind: "delete" }, observedRevision: older.lastRevision }, () => 101);
    await journal.admit(latest);
    const nativeRemove = Storage.prototype.removeItem;
    let failed = false;
    Storage.prototype.removeItem = function (key) {
      if (key === probe.stageKey(older.uuid)) throw new DOMException("Injected cleanup failure", "QuotaExceededError");
      nativeRemove.call(this, key);
    };
    try { await journal.complete(latest); } catch { failed = true; }
    finally { Storage.prototype.removeItem = nativeRemove; }
    const shared = localStorage.getItem(probe.recordKey(probe.body.id));
    const recovered = await new probe.DrawingJournal().recover(probe.body.id);
    await journal.complete(latest);
    const resurrected = await journal.admit(older);
    return { failed, shared: shared === null ? null : JSON.parse(shared), latest, recovered, resurrected, remaining: Object.keys(localStorage) };
  });
  expect(result.failed).toBe(true);
  expect(result.shared).toEqual(result.latest);
  expect(result.recovered).toEqual(result.latest);
  expect(result.resurrected).toBe(false);
  expect(result.remaining).toEqual([]);
  await info.attach("cleanup-storage-failure.json", { body: JSON.stringify(result), contentType: "application/json" });
});
