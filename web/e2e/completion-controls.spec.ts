import { test as browserTest, expect, type Page } from "@playwright/test";
import path from "node:path";
import { createServer } from "vite";
import { parseJournalRecord } from "../src/chart/drawings/journal";
import type {} from "./completion-probe";

const test = browserTest.extend<{ completionUrl: string }>({
  completionUrl: async ({}, use) => {
    const server = await createServer({
      root: path.resolve(import.meta.dirname, ".."), configFile: false, envDir: false, appType: "custom",
      server: { host: "127.0.0.1", port: 0 },
    });
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><script type="module" src="/e2e/completion-probe.ts"></script>');
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === "string") throw new Error("Expected the loopback completion adapter server");
      await use(`http://127.0.0.1:${address.port}`);
    } finally { await server.close(); }
  },
});

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => window.completionProbe !== undefined);
}

async function pauseFullStage(page: Page) {
  let release = () => {};
  let observed = (_raw: unknown) => {};
  const held = new Promise<unknown>((resolve) => { observed = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/__completion-native-stage", async (route) => {
    observed(route.request().postDataJSON());
    await released;
    if (!page.isClosed()) await route.fulfill({ status: 200, body: "released" });
  });
  await page.evaluate(() => {
    const nativeSet = Storage.prototype.setItem;
    let first = true;
    Storage.prototype.setItem = function (key, value) {
      if (first && key.startsWith(window.completionProbe.STAGING_PREFIX)) {
        first = false;
        const gate = new XMLHttpRequest();
        gate.open("POST", "/__completion-native-stage", false);
        gate.setRequestHeader("content-type", "application/json");
        gate.send(value);
      }
      nativeSet.call(this, key, value);
    };
  });
  return { held, release: () => release() };
}

function publish(page: Page) {
  return page.evaluate(async () => {
    const p = window.completionProbe;
    const journal = new p.DrawingJournal();
    const completionBefore = localStorage.getItem(p.completionKey(p.body.id));
    const intent = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "put", body: p.body }, observedRevision: 0 }, () => 100);
    const completionAfterStage = localStorage.getItem(p.completionKey(p.body.id));
    p.intents.set("published", intent);
    return { intent, completionBefore, completionAfterStage, admitted: await journal.admit(intent) };
  });
}

function completeDelete(page: Page, clock = 200) {
  return page.evaluate(async (clock) => {
    const p = window.completionProbe;
    const journal = new p.DrawingJournal();
    const intent = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "delete" }, observedRevision: 0 }, () => clock);
    await journal.admit(intent);
    await journal.complete(intent);
    return intent;
  }, clock);
}

for (const warm of [false, true]) {
  test(`native completion: first full-stage write resumes below completed DELETE with ${warm ? "warm" : "cold"} Storage`, async ({ page, context, completionUrl }, info) => {
    await open(page, completionUrl);
    const other = await context.newPage();
    await open(other, completionUrl);
    if (warm) await completeDelete(other, 1);
    const gate = await pauseFullStage(page);
    const publishing = publish(page);
    try {
      const hidden = parseJournalRecord(await gate.held);
      if (hidden === null) throw new Error("Expected the reserved full-stage payload");
      const terminal = await completeDelete(other);
      expect(hidden.order).toBeLessThan(terminal.order);
      const checkpoint = await other.evaluate(() => Object.keys(localStorage));
      expect(checkpoint).toEqual([await other.evaluate(() => window.completionProbe.completionKey(window.completionProbe.body.id))]);
      gate.release();
      const result = await publishing;
      expect(result.intent).toEqual(hidden);
      expect(result.admitted).toBe(false);
      const retired = await page.evaluate(async () => {
        const p = window.completionProbe;
        const intent = p.intents.get("published");
        if (intent === undefined) throw new Error("Expected the resumed intent");
        const writes: string[] = [];
        const nativeSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) { writes.push(key); nativeSet.call(this, key, value); };
        try {
          const journal = new p.DrawingJournal();
          return { admitted: await journal.admit(intent), recovered: await journal.recover(intent.id), writes };
        } finally { Storage.prototype.setItem = nativeSet; }
      });
      expect(retired).toEqual({ admitted: false, recovered: null, writes: [] });
      await info.attach("reserved-stage-completion.json", { body: JSON.stringify({ warm, hidden, terminal, checkpoint, result, retired }, null, 2), contentType: "application/json" });
    } finally { gate.release(); await publishing; }
  });
}

test("native completion: equal-order UUID tie across documents suppresses only the lower reserved stage", async ({ page, context, completionUrl }, info) => {
  await open(page, completionUrl);
  const other = await context.newPage();
  await open(other, completionUrl);
  await page.evaluate(() => { crypto.randomUUID = () => "01900000-0000-7000-8000-000000000001"; });
  await other.evaluate(() => { crypto.randomUUID = () => "01900000-0000-7000-8000-000000000002"; });
  const lowGate = await pauseFullStage(page);
  const lower = publish(page);
  const low = parseJournalRecord(await lowGate.held);
  const highGate = await pauseFullStage(other);
  const higher = publish(other);
  try {
    const high = parseJournalRecord(await highGate.held);
    if (low === null || high === null) throw new Error("Expected both reserved tie intents");
    expect(low.order).toBe(high.order);
    expect(low.uuid < high.uuid).toBe(true);
    highGate.release();
    expect((await higher).admitted).toBe(true);
    await other.evaluate(async () => {
      const p = window.completionProbe;
      const intent = p.intents.get("published");
      if (intent === undefined) throw new Error("Expected the higher UUID intent");
      await new p.DrawingJournal().complete(intent);
    });
    lowGate.release();
    expect((await lower).admitted).toBe(false);
    expect(await other.evaluate(() => new window.completionProbe.DrawingJournal().recover(window.completionProbe.body.id))).toBeNull();
    await info.attach("cross-document-uuid-tie.json", { body: JSON.stringify({ low, high }), contentType: "application/json" });
  } finally { lowGate.release(); highGate.release(); await Promise.all([lower, higher]); }
});

for (const failureAt of [0, 1, 2, 3, 4]) {
  test(`native completion: cleanup removal ${failureAt + 1} failure cannot replay older work after reload`, async ({ page, completionUrl }, info) => {
    await open(page, completionUrl);
    const result = await page.evaluate(async (failureAt) => {
      const p = window.completionProbe;
      const journal = new p.DrawingJournal();
      const older = [100, 101, 102].map((clock) => journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "put", body: p.body }, observedRevision: 0 }, () => clock));
      const latest = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "delete" }, observedRevision: 0 }, () => 200);
      await journal.admit(latest);
      const expected = [...older.map((intent) => p.stageKey(intent.uuid)), p.stageKey(latest.uuid), p.recordKey(latest.id)];
      const attempted: string[] = [];
      const nativeRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        attempted.push(key);
        if (attempted.length === failureAt + 1) throw new DOMException("Injected cleanup removal failure", "QuotaExceededError");
        nativeRemove.call(this, key);
      };
      let error = "";
      try { await journal.complete(latest); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      finally { Storage.prototype.removeItem = nativeRemove; }
      const watermark = localStorage.getItem(p.completionKey(latest.id));
      nativeRemove.call(localStorage, p.stageKey(latest.uuid));
      nativeRemove.call(localStorage, p.recordKey(latest.id));
      return { latest, older, expected, attempted, error, watermark, remaining: Object.keys(localStorage) };
    }, failureAt);
    expect(result.error).toBe("Injected cleanup removal failure");
    expect(result.attempted).toEqual(result.expected.slice(0, failureAt + 1));
    expect(result.watermark).not.toBeNull();
    await page.reload();
    await page.waitForFunction(() => window.completionProbe !== undefined);
    const restored = await page.evaluate(async ({ latest, older }) => {
      const p = window.completionProbe;
      const journal = new p.DrawingJournal();
      let launches = 0;
      const recovered = await journal.recover(latest.id);
      const admitted = await Promise.all(older.map((intent) => journal.admit(intent)));
      const launched = await Promise.all(older.map((intent) => journal.launch(intent, () => { launches += 1; return true; })));
      return { recovered, admitted, launched, launches, keys: Object.keys(localStorage), watermark: localStorage.getItem(p.completionKey(latest.id)) };
    }, result);
    expect(restored.recovered).toBeNull();
    expect(restored.admitted).toEqual([false, false, false]);
    expect(restored.launched).toEqual([false, false, false]);
    expect(restored.launches).toBe(0);
    expect(restored.keys).toHaveLength(1);
    expect(restored.watermark).toBe(result.watermark);
    await info.attach("partial-cleanup-reload.json", { body: JSON.stringify({ failureAt, result, restored }, null, 2), contentType: "application/json" });
  });
}

test("native completion: watermark quota failure performs no cleanup and retry leaves durable suppression", async ({ page, completionUrl }, info) => {
  await open(page, completionUrl);
  const result = await page.evaluate(async () => {
    const p = window.completionProbe;
    const journal = new p.DrawingJournal();
    const older = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "put", body: p.body }, observedRevision: 0 }, () => 100);
    const latest = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "delete" }, observedRevision: 0 }, () => 200);
    await journal.admit(latest);
    const before = Object.entries(localStorage).sort();
    const nativeSet = Storage.prototype.setItem;
    const nativeRemove = Storage.prototype.removeItem;
    const removed: string[] = [];
    Storage.prototype.setItem = function (key, value) {
      if (key === p.completionKey(latest.id)) throw new DOMException("Injected completion quota failure", "QuotaExceededError");
      nativeSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) { removed.push(key); nativeRemove.call(this, key); };
    let error = "";
    try { await journal.complete(latest); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    finally { Storage.prototype.setItem = nativeSet; Storage.prototype.removeItem = nativeRemove; }
    const after = Object.entries(localStorage).sort();
    const recoveredBeforeRetry = await journal.recover(latest.id);
    await journal.complete(latest);
    return { before, after, removed, error, latest, recoveredBeforeRetry, recovered: await journal.recover(latest.id), admitted: await journal.admit(older), keys: Object.keys(localStorage), completionKey: p.completionKey(latest.id) };
  });
  expect(result.error).toBe("Injected completion quota failure");
  expect(result.removed).toEqual([]);
  expect(result.after).toEqual(result.before);
  expect(result.recoveredBeforeRetry).toEqual(result.latest);
  expect(result.recovered).toBeNull();
  expect(result.admitted).toBe(false);
  expect(result.keys).toEqual([result.completionKey]);
  await info.attach("watermark-quota-retry.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});

test("native completion: old ACK preserves higher same-id and unrelated work and cannot recreate a missing stage", async ({ page, completionUrl }, info) => {
  await open(page, completionUrl);
  const result = await page.evaluate(async () => {
    const p = window.completionProbe;
    const journal = new p.DrawingJournal();
    const input = { id: p.body.id, symbol: p.body.symbol, want: { kind: "put", body: p.body }, observedRevision: 0 } satisfies Parameters<typeof journal.stage>[0];
    const older = journal.stage(input, () => 100);
    await journal.admit(older);
    const higher = journal.stage(input, () => 200);
    await journal.admit(higher);
    const otherBody = { ...p.body, id: "unrelated" };
    const unrelated = journal.stage({ id: otherBody.id, symbol: otherBody.symbol, want: { kind: "put", body: otherBody }, observedRevision: 0 }, () => 10);
    await journal.admit(unrelated);
    const untouchedKeys = [p.stageKey(higher.uuid), p.recordKey(higher.id), p.stageKey(unrelated.uuid), p.recordKey(unrelated.id)];
    const before = untouchedKeys.map((key) => [key, localStorage.getItem(key)]);
    await journal.complete(older);
    const after = untouchedKeys.map((key) => [key, localStorage.getItem(key)]);
    const recoveredHigher = await journal.recover(higher.id);
    const recoveredUnrelated = await journal.recover(unrelated.id);
    await journal.complete(higher);
    const watermarkBefore = localStorage.getItem(p.completionKey(higher.id));
    const nativeSet = Storage.prototype.setItem;
    const writes: string[] = [];
    Storage.prototype.setItem = function (key, value) { writes.push(key); nativeSet.call(this, key, value); };
    try {
      await journal.complete(older);
      return { before, after, older, higher, unrelated, recoveredHigher, recoveredUnrelated, watermarkBefore, watermarkAfter: localStorage.getItem(p.completionKey(higher.id)), readmitted: await journal.admit(older), writes };
    } finally { Storage.prototype.setItem = nativeSet; }
  });
  expect(result.after).toEqual(result.before);
  expect(result.recoveredHigher).toEqual(result.higher);
  expect(result.recoveredUnrelated).toEqual(result.unrelated);
  expect(result.unrelated.order).toBe(10);
  expect(result.watermarkAfter).toBe(result.watermarkBefore);
  expect(result.readmitted).toBe(false);
  expect(result.writes).toEqual([]);
  await info.attach("greater-unrelated-retired.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});

for (const version of [1, 2]) {
  test(`native completion: v${version} recovery waits for its per-id lock and preserves fixed revision`, async ({ page, context, completionUrl }, info) => {
    await open(page, completionUrl);
    const holder = await context.newPage();
    await open(holder, completionUrl);
    const legacy = await holder.evaluate(async (version) => {
      const p = window.completionProbe;
      const shared = { v: version, id: p.body.id, symbol: p.body.symbol, uuid: "01900000-0000-7000-8000-000000000073", order: 700, want: { kind: "put", reserved: true, body: { ...p.body, revision: 731 } }, lastRevision: 731 };
      localStorage.setItem(p.recordKey(shared.id), JSON.stringify(shared));
      if (version === 2) localStorage.setItem(p.stageKey(shared.uuid), JSON.stringify(shared));
      await new Promise<void>((acquired) => {
        void navigator.locks.request(p.journalLock(shared.id), async () => {
          const released = new Promise<void>((resolve) => { p.release = resolve; });
          acquired();
          await released;
        });
      });
      return { shared, records: Object.entries(localStorage).sort() };
    }, version);
    try {
      await page.evaluate(() => {
        const p = window.completionProbe;
        p.tasks.set("recovery", new p.DrawingJournal().recover(p.body.id));
      });
      await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).pending?.length)).toBe(1);
      expect(await holder.evaluate(() => Object.entries(localStorage).sort())).toEqual(legacy.records);
      await holder.evaluate(() => window.completionProbe.release());
      const recovered = parseJournalRecord(await page.evaluate(() => window.completionProbe.tasks.get("recovery")));
      if (recovered === null) throw new Error("Expected locked legacy recovery");
      expect(recovered.want).toMatchObject({ kind: "put", reserved: true, body: { revision: 731 } });
      if (version === 2) expect(recovered).toEqual(legacy.shared);
      await page.reload();
      await page.waitForFunction(() => window.completionProbe !== undefined);
      const replay = await page.evaluate(async ({ recovered, legacy }) => {
        const p = window.completionProbe;
        const journal = new p.DrawingJournal();
        const restored = await journal.recover(recovered.id);
        await journal.complete(recovered);
        localStorage.setItem(p.recordKey(recovered.id), JSON.stringify(legacy.shared));
        if (legacy.shared.v === 2) localStorage.setItem(p.stageKey(legacy.shared.uuid), JSON.stringify(legacy.shared));
        return { restored, completedReplay: await journal.recover(recovered.id), keys: Object.keys(localStorage), watermarkKey: p.completionKey(recovered.id) };
      }, { recovered, legacy });
      expect(replay.restored).toEqual(recovered);
      expect(replay.completedReplay).toBeNull();
      expect(replay.keys).toEqual([replay.watermarkKey]);
      await info.attach("locked-fixed-revision-migration.json", { body: JSON.stringify({ version, legacy, recovered, replay }, null, 2), contentType: "application/json" });
    } finally { await holder.evaluate(() => window.completionProbe.release()); }
  });
}

for (const failure of ["malformed", "wrong-id", "read", "lock-rejected", "lock-unsupported"] as const) {
  test(`native completion: ${failure} metadata boundary fails explicitly before launch or cleanup`, async ({ page, completionUrl }, info) => {
    await open(page, completionUrl);
    const result = await page.evaluate(async (failure) => {
      const p = window.completionProbe;
      const journal = new p.DrawingJournal();
      const intent = journal.stage({ id: p.body.id, symbol: p.body.symbol, want: { kind: "put", body: p.body }, observedRevision: 0 }, () => 100);
      await journal.admit(intent);
      if (failure === "malformed") localStorage.setItem(p.completionKey(intent.id), "invalid-json");
      if (failure === "wrong-id") localStorage.setItem(p.completionKey(intent.id), JSON.stringify({ v: 1, id: "different", uuid: intent.uuid, order: intent.order, lastRevision: intent.lastRevision }));
      const before = Object.entries(localStorage).sort();
      const nativeGet = Storage.prototype.getItem;
      const nativeRemove = Storage.prototype.removeItem;
      const nativeRequest = navigator.locks.request;
      const removed: string[] = [];
      if (failure === "read") Storage.prototype.getItem = function (key) {
        if (key === p.completionKey(intent.id)) throw new DOMException("Injected completion read failure", "SecurityError");
        return nativeGet.call(this, key);
      };
      if (failure === "lock-rejected") navigator.locks.request = () => Promise.reject(new DOMException("Injected completion lock failure", "SecurityError"));
      if (failure === "lock-unsupported") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      Storage.prototype.removeItem = function (key) { removed.push(key); nativeRemove.call(this, key); };
      const guarded = new p.DrawingJournal();
      let launches = 0;
      const errors: Record<string, string> = {};
      const operations = {
        admit: () => guarded.admit(intent), recover: () => guarded.recover(intent.id),
        launch: () => guarded.launch(intent, () => { launches += 1; return true; }), complete: () => guarded.complete(intent),
      };
      try {
        for (const [name, operation] of Object.entries(operations)) {
          try { await operation(); } catch (caught) { errors[name] = caught instanceof Error ? caught.message : String(caught); }
        }
      } finally {
        Storage.prototype.getItem = nativeGet;
        Storage.prototype.removeItem = nativeRemove;
        if (failure !== "lock-unsupported") navigator.locks.request = nativeRequest;
      }
      return { before, after: Object.entries(localStorage).sort(), removed, errors, launches };
    }, failure);
    expect(Object.keys(result.errors).sort()).toEqual(["admit", "complete", "launch", "recover"]);
    expect(Object.values(result.errors).every((message) => message.length > 0)).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.launches).toBe(0);
    expect(result.after).toEqual(result.before);
    await info.attach("explicit-metadata-boundary.json", { body: JSON.stringify({ failure, result }, null, 2), contentType: "application/json" });
  });
}

test("native completion adapter: failed legacy cleanup keeps the first migration UUID and revision after reload", async ({ page, completionUrl }, info) => {
  await open(page, completionUrl);
  const result = await page.evaluate(async () => {
    const probe = window.completionProbe;
    const legacy = { v: 1, id: probe.body.id, symbol: probe.body.symbol, want: { kind: "put", body: probe.body }, lastRevision: 0 };
    localStorage.setItem(probe.recordKey(probe.body.id), JSON.stringify(legacy));
    const nativeRemove = Storage.prototype.removeItem;
    const nativeNow = Date.now;
    Date.now = () => 300;
    Storage.prototype.removeItem = function(key) {
      if (key === probe.recordKey(probe.body.id)) throw new DOMException("Injected legacy cleanup failure", "QuotaExceededError");
      nativeRemove.call(this, key);
    };
    let failed = false;
    try { await new probe.DrawingJournal().recover(probe.body.id); } catch { failed = true; }
    finally { Storage.prototype.removeItem = nativeRemove; Date.now = nativeNow; }
    const stages = Object.keys(localStorage).filter(key => key.startsWith(probe.STAGING_PREFIX)).map(key => probe.parseJournalRecord(JSON.parse(localStorage.getItem(key) ?? "null")));
    return { failed, stages };
  });
  expect(result.failed).toBe(true);
  expect(result.stages).toHaveLength(1);
  const [first] = result.stages;
  if (!first) throw new Error("Expected the first durable legacy migration");
  expect(first.want).toMatchObject({ kind: "put", body: { revision: 300 } });
  await page.reload();
  await page.waitForFunction(() => window.completionProbe !== undefined);
  const recovered = await page.evaluate(async () => {
    const probe = window.completionProbe;
    const nativeNow = Date.now;
    Date.now = () => 3000;
    try { return await new probe.DrawingJournal().recover(probe.body.id); }
    finally { Date.now = nativeNow; }
  });
  expect(recovered).toEqual(first);
  await info.attach("partial-legacy-migration.json", { body: JSON.stringify({ first, recovered }), contentType: "application/json" });
});
